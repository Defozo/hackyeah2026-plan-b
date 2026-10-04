import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../../.runtime/public-site/dist/server/index.js";

const origin = "https://plan-b-defozo.defozo.chatgpt.site";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("./drizzle/0000_technical_state.sql", import.meta.url),
      "utf8",
    ),
  );
  const binding = {
    prepare(sql) {
      let values = [];
      return {
        bind(...v) {
          values = v;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) || null;
        },
        async run() {
          return db.prepare(sql).run(...values);
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  };
  const env = {
    DB: binding,
    APP_ORIGIN: origin,
    PLANB_SESSION_SECRET: "unit-only-secret-for-public-worker-123456",
    ASSETS: {
      fetch: async () =>
        new Response("synthetic-asset", {
          headers: { "Content-Type": "audio/wav" },
        }),
    },
  };
  const pending = [];
  const call = (path, init) =>
    worker.fetch(new Request(origin + path, init), env, {
      waitUntil: (p) => pending.push(p),
    });
  const close = async () => {
    await Promise.all(pending);
    db.close();
  };
  return { call, close };
}
async function login(s) {
  const r = await s.call("/api/capabilities");
  return {
    body: await r.json(),
    cookie: r.headers.get("set-cookie").split(";")[0],
    header: r.headers.get("set-cookie"),
  };
}
function post(cookie, csrfToken, extra = {}) {
  return {
    method: "POST",
    headers: {
      origin,
      cookie,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      consent: { provider: "groq", purpose: "text-draft", approved: true },
      syntheticId: "shift-change",
      ...extra,
    }),
  };
}
test("anonymous capabilities create a secure reusable session, with honest disabled AI", async () => {
  const s = setup();
  const first = await login(s);
  assert.equal(first.body.aiEnabled, false);
  assert.equal(first.body.nfz, true);
  assert.match(
    first.header,
    /HttpOnly; SameSite=Strict; Max-Age=86400; Secure/,
  );
  const next = await s.call("/api/capabilities", {
    headers: { cookie: first.cookie },
  });
  assert.equal((await next.json()).csrfToken, first.body.csrfToken);
  await s.close();
});
test("CSRF and origin are enforced before any state-changing endpoint", async () => {
  const s = setup();
  const a = await login(s);
  const bad = post(a.cookie, "wrong");
  assert.equal((await s.call("/api/text-draft", bad)).status, 403);
  bad.headers.origin = "https://attacker.example";
  assert.equal((await s.call("/api/text-draft", bad)).status, 403);
  await s.close();
});
test("a valid synthetic request returns a factual template and explicit AI_DISABLED", async () => {
  const s = setup();
  const a = await login(s);
  const r = await s.call("/api/text-draft", post(a.cookie, a.body.csrfToken));
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.reason, "AI_DISABLED");
  assert.deepEqual(
    body.draft.orderedFactIds,
    body.facts.map((f) => f.id),
  );
  assert.equal(body.needsReview, true);
  await s.close();
});
test("personal facts cannot be sent via the public adapter", async () => {
  const s = setup();
  const a = await login(s);
  const r = await s.call(
    "/api/text-draft",
    post(a.cookie, a.body.csrfToken, { facts: [{ text: "private" }] }),
  );
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "PERSONAL_AI_DISABLED");
  await s.close();
});
test("D1 rate limits apply across requests", async () => {
  const s = setup();
  const a = await login(s);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await s.call("/api/text-draft", post(a.cookie, a.body.csrfToken)))
        .status,
      200,
    );
  const blocked = await s.call(
    "/api/text-draft",
    post(a.cookie, a.body.csrfToken),
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  await s.close();
});
test("NFZ input rejects missing category, duplicates and unknown proxy parameters", async () => {
  const s = setup();
  for (const q of [
    "benefit=abc&locality=abc",
    "benefit=abc&locality=abc&case=1&case=2",
    "benefit=abc&locality=abc&case=1&url=https://evil.test",
  ])
    assert.equal((await s.call("/api/care/queues?" + q)).status, 400);
  await s.close();
});
test("synthetic WAV remains available and API responses cannot be cached", async () => {
  const s = setup();
  const r = await s.call("/api/synthetic-audio/polish-note");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(
    r.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  await s.close();
});
test("NFZ uses manual redirect mode and rejects every upstream redirect", async () => {
  const s = setup();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://unrelated.invalid" },
    });
  };
  try {
    const result = await s.call("/api/care/benefits?q=redirect-contract-test");
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error, "NFZ_UNAVAILABLE");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await s.close();
  }
});
test("HTML shell is served by Worker with content security policy", async () => {
  const s = setup();
  for (const path of ["/", "/index.html"]) {
    const result = await s.call(path);
    assert.equal(result.status, 200);
    assert.equal(
      result.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.match(
      result.headers.get("content-security-policy"),
      /script-src 'self'/,
    );
    assert.equal(result.headers.get("cache-control"), "no-cache");
  }
  await s.close();
});
test("public MP4 supports full, single, suffix, open ranges and HEAD without changing bytes", async () => {
  const s = setup();
  const path = "/materialy/Plan-B-demo.mp4";
  const full = await s.call(path);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(await full.text(), "synthetic-asset");
  for (const [range, text, contentRange] of [
    ["bytes=0-3", "synt", "bytes 0-3/15"],
    ["bytes=10-", "asset", "bytes 10-14/15"],
    ["bytes=-5", "asset", "bytes 10-14/15"],
    ["bytes=10-99", "asset", "bytes 10-14/15"],
  ]) {
    const partial = await s.call(path, { headers: { Range: range } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), contentRange);
    assert.equal(Number(partial.headers.get("content-length")), text.length);
    assert.equal(await partial.text(), text);
  }
  for (const range of ["bytes=15-", "bytes=-0", "bytes=5-2"]) {
    const invalid = await s.call(path, { headers: { Range: range } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */15");
    assert.equal(await invalid.text(), "");
  }
  const head = await s.call(path, {
    method: "HEAD",
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "15");
  assert.equal(await head.text(), "");
  const stale = await s.call(path, {
    headers: { Range: "bytes=0-3", "If-Range": '"old"' },
  });
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), "synthetic-asset");
  await s.close();
});

test("song and narration resolve distinct fixed assets and ignore asset query parameters", async () => {
  const assets = {
    "/_planb/demo.bin": "narration-video",
    "/_planb/song-2026-10-04-d82a354873b2.bin": "song-video",
  };
  const requested = [];
  const env = { ASSETS: { fetch: async (request) => {
    const path = new URL(request.url).pathname;
    requested.push(path);
    return Object.hasOwn(assets, path)
      ? new Response(assets[path])
      : new Response("missing", { status: 404 });
  } } };
  for (const [path, expected, backing] of [
    ["/materialy/Plan-B-demo.mp4", "narration-video", "/_planb/demo.bin"],
    ["/materialy/Plan-B-song-2026-10-04-d82a354873b2.mp4", "song-video", "/_planb/song-2026-10-04-d82a354873b2.bin"],
  ]) {
    const response = await worker.fetch(new Request(origin + path + "?asset=/_planb/shell.txt", {
      headers: { Range: "bytes=0-3" },
    }), env, {});
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("content-range"), `bytes 0-3/${expected.length}`);
    assert.equal(await response.text(), expected.slice(0, 4));
    assert.equal(requested.at(-1), backing);
  }
  const unknown = await worker.fetch(new Request(origin + "/materialy/other.mp4"), env, {});
  assert.equal(unknown.status, 404);
  assert.equal(requested.at(-1), "/materialy/other.mp4");
});
