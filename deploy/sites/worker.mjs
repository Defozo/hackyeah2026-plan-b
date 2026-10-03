// Public demo adapter. No AI client or provider secret is included in this runtime.
// The full Fastify/SQLite/ffmpeg backend remains in apps/api for container deployments.
import { NfzService } from "./nfz.js";
import { syntheticFacts, audioFixtureText } from "./fixtures.js";

const nfz = new NfzService(
  {
    nfzBaseUrl: "https://apinfz.nfz.gov.pl/app-itl-api-pcus/",
    nfzCacheTtlSeconds: 900,
  },
  // Sites currently rejects redirect:"error". Manual preserves the same policy:
  // NfzService rejects every non-2xx response, including every redirect.
  (url, options) => fetch(url, { ...options, redirect: "manual" }),
);
const encoder = new TextEncoder();
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
const error = (code, status = 400, message) =>
  json({ error: code, ...(message ? { message } : {}) }, status);
const random = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function signature(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, encoder.encode(text)),
      ),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function session(request, env) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("planb_session="))
    ?.slice(14);
  if (!token || token.length > 200) return null;
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]{32}$/.test(parts[0]) ||
    parts[1] !== (await signature(env.PLANB_SESSION_SECRET, parts[0]))
  )
    return null;
  return env.DB.prepare(
    "SELECT id,csrf,expires FROM sessions WHERE id=? AND expires>?",
  )
    .bind(parts[0], Date.now())
    .first();
}
async function rate(env, key, maximum) {
  const window = Math.floor(Date.now() / 60000);
  const result = await env.DB.prepare(
    "INSERT INTO limits(bucket,count,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(`${key}:${window}`, (window + 1) * 60000)
    .first();
  return result.count <= maximum;
}
async function limitedBody(request) {
  if (Number(request.headers.get("content-length")) > 16384) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 16384) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
function validQuery(url, queues) {
  const permitted = queues
    ? ["benefit", "locality", "case", "page"]
    : ["q", "page"];
  if (
    [...url.searchParams.keys()].some(
      (k) => !permitted.includes(k) || url.searchParams.getAll(k).length !== 1,
    )
  )
    return false;
  const page = url.searchParams.get("page") || "1";
  if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 10000)
    return false;
  if (queues) {
    return (
      ["benefit", "locality"].every((k) => {
        const t = url.searchParams.get(k);
        return t && t.length >= 2 && t.length <= 250;
      }) && ["1", "2"].includes(url.searchParams.get("case"))
    );
  }
  return (url.searchParams.get("q") || "").length <= 250;
}
async function api(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/health/live") return json({ status: "live" });
  if (
    !env.DB ||
    !env.PLANB_SESSION_SECRET ||
    env.PLANB_SESSION_SECRET.length < 32
  )
    return error("CONFIGURATION_UNAVAILABLE", 503);
  if (path === "/health/ready") {
    await env.DB.prepare(
      "SELECT count(*) AS count FROM sessions WHERE 0",
    ).first();
    return json({
      status: "ready",
      localConfigurationOnly: true,
      aiConfigured: false,
      nfzConfigured: true,
      technicalStore: "D1",
      paidOperations: "disabled",
    });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== env.APP_ORIGIN) return error("ORIGIN_REJECTED", 403);
  const ip = await signature(
    env.PLANB_SESSION_SECRET,
    request.headers.get("cf-connecting-ip") || "shared-edge",
  );
  if (!(await rate(env, `ip:${ip}`, 120)))
    return json({ error: "RATE_LIMIT" }, 429, { "Retry-After": "60" });
  // Delete only expired technical state. No product or imported data are stored here.
  ctx.waitUntil(
    env.DB.batch([
      env.DB.prepare("DELETE FROM limits WHERE expires<?").bind(Date.now()),
      env.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(Date.now()),
    ]).catch(() => {}),
  );
  if (request.method === "GET" && path === "/api/capabilities") {
    let current = await session(request, env);
    if (!current) {
      current = {
        id: random(),
        csrf: random(),
        expires: Date.now() + 86400000,
      };
      await env.DB.prepare(
        "INSERT INTO sessions(id,csrf,expires) VALUES(?,?,?)",
      )
        .bind(current.id, current.csrf, current.expires)
        .run();
    }
    return json(
      {
        aiEnabled: false,
        personalAiEnabled: false,
        textDraft: false,
        transcription: false,
        nfz: true,
        models: { text: "openai/gpt-oss-120b", stt: "whisper-large-v3-turbo" },
        limits: { audioSeconds: 60, uploadMb: 10 },
        csrfToken: current.csrf,
        syntheticFixtures: Object.entries(syntheticFacts).map(
          ([id, facts]) => ({
            id,
            label:
              id === "shift-change" ? "Zmiana grafiku" : "Przed konsultacją",
            text: facts.map((f) => f.text).join(" "),
          }),
        ),
        audioFixture: {
          id: "polish-note",
          text: audioFixtureText,
          url: "/api/synthetic-audio/polish-note",
        },
        privacy: {
          provider: "Groq",
          personalTransmission: "disabled",
          retainedByApi: "technical-sessions-and-rate-limits-only",
          providerRetentionReviewed: false,
        },
      },
      200,
      {
        "Set-Cookie": `planb_session=${current.id}.${await signature(env.PLANB_SESSION_SECRET, current.id)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`,
      },
    );
  }
  if (request.method === "GET" && path === "/api/synthetic-audio/polish-note") {
    return env.ASSETS.fetch(
      new Request(
        new URL("/demo-assets/polish-note.wav", request.url),
        request,
      ),
    );
  }
  if (request.method === "POST") {
    if (!origin || origin !== env.APP_ORIGIN)
      return error("ORIGIN_REQUIRED", 403);
    const current = await session(request, env);
    if (!current || request.headers.get("x-csrf-token") !== current.csrf)
      return error("CSRF_REJECTED", 403);
    if (
      !(await rate(env, `post-session:${current.id}`, 5)) ||
      !(await rate(env, `post-ip:${ip}`, 15))
    )
      return json({ error: "RATE_LIMIT" }, 429, { "Retry-After": "60" });
    if (!["/api/text-draft", "/api/transcribe"].includes(path))
      return error("NOT_FOUND", 404);
    const body = await limitedBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return error("INVALID_REQUEST");
    const purpose = path === "/api/text-draft" ? "text-draft" : "transcribe";
    if (
      body.consent?.provider !== "groq" ||
      body.consent?.purpose !== purpose ||
      typeof body.consent?.approved !== "boolean"
    )
      return error("INVALID_REQUEST");
    if (path === "/api/transcribe")
      return error(
        body.consent.approved ? "AI_DISABLED" : "CONSENT_REQUIRED",
        body.consent.approved ? 503 : 403,
        "Dyktowanie jest wyłączone. Możesz wpisać tekst.",
      );
    if (body.facts || !body.syntheticId)
      return error("PERSONAL_AI_DISABLED", 403);
    if (!Object.hasOwn(syntheticFacts, body.syntheticId))
      return error("INVALID_REQUEST");
    if (
      Object.keys(body).some(
        (k) => !["consent", "syntheticId", "purpose"].includes(k),
      ) ||
      (body.purpose && !["care-packet", "note"].includes(body.purpose))
    )
      return error("INVALID_REQUEST");
    const facts = syntheticFacts[body.syntheticId];
    return json({
      mode: "template",
      draft: {
        templateId:
          body.purpose === "care-packet" ||
          (!body.purpose && body.syntheticId === "care-packet")
            ? "care-summary"
            : "note-summary",
        sourceIds: [...new Set(facts.map((f) => f.sourceId))],
        orderedFactIds: facts.map((f) => f.id),
        missingCodes: ["NEEDS_USER_CONFIRMATION"],
      },
      facts,
      reason: body.consent.approved ? "AI_DISABLED" : "CONSENT_REQUIRED",
      needsReview: true,
    });
  }
  const type = path.slice("/api/care/".length);
  if (
    request.method === "GET" &&
    path.startsWith("/api/care/") &&
    ["benefits", "localities", "queues"].includes(type)
  ) {
    if (!validQuery(url, type === "queues")) return error("INVALID_REQUEST");
    const params =
      type === "queues"
        ? Object.fromEntries(url.searchParams)
        : {
            name: url.searchParams.get("q") || "",
            page: url.searchParams.get("page") || "1",
          };
    try {
      return json(await nfz.search(type, params));
    } catch {
      return error(
        "NFZ_UNAVAILABLE",
        502,
        "Nie udało się pobrać danych NFZ. To błąd połączenia, nie brak wyników.",
      );
    }
  }
  return error("NOT_FOUND", 404);
}
// Sites' static edge ignores byte ranges. Keep the immutable MP4 bytes in a
// different asset path and serve the public URL here so browser seeking works.
async function demoVideo(request, env) {
  const asset = await env.ASSETS.fetch(
    new Request(new URL("/_planb/demo.bin", request.url)),
  );
  if (!asset.ok) return asset;
  const bytes = await asset.arrayBuffer();
  const length = bytes.byteLength;
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
    "Cache-Control": "public, max-age=86400",
  });
  for (const name of ["ETag", "Last-Modified"]) {
    if (asset.headers.has(name)) headers.set(name, asset.headers.get(name));
  }
  // RFC 9110 defines Range for GET only. HEAD reports the complete resource.
  if (request.method === "HEAD") return new Response(null, { headers });
  const ifRange = request.headers.get("If-Range");
  const range =
    !ifRange ||
    ifRange === headers.get("ETag") ||
    ifRange === headers.get("Last-Modified")
      ? request.headers.get("Range")
      : null;
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  // Unsupported multi-ranges are ignored and return the complete representation.
  if (!match) return new Response(bytes, { headers });
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : length - 1;
  if (!match[1] && match[2]) {
    start = Math.max(0, length - Number(match[2]));
    end = length - 1;
  }
  if (
    (!match[1] && !match[2]) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= length ||
    start > end
  ) {
    headers.set("Content-Range", `bytes */${length}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  end = Math.min(end, length - 1);
  headers.set("Content-Range", `bytes ${start}-${end}/${length}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(new Uint8Array(bytes, start, end - start + 1), {
    status: 206,
    headers,
  });
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;
    try {
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/health/")
      )
        response = await api(request, env, ctx, url);
      else {
        if (!["GET", "HEAD"].includes(request.method))
          return error("METHOD_NOT_ALLOWED", 405);
        const shell = async () => {
          const asset = await env.ASSETS.fetch(
            new Request(new URL("/_planb/shell.txt", request.url), request),
          );
          const html = new Response(asset.body, asset);
          html.headers.set("Content-Type", "text/html; charset=utf-8");
          return html;
        };
        response =
          url.pathname === "/materialy/Plan-B-demo.mp4"
            ? await demoVideo(request, env)
            : ["/", "/index.html"].includes(url.pathname)
              ? await shell()
              : await env.ASSETS.fetch(request);
        if (
          response.status === 404 &&
          !url.pathname.includes(".") &&
          !url.pathname.startsWith("/materialy/")
        )
          response = await shell();
      }
    } catch {
      response = error(
        "INTERNAL_ERROR",
        503,
        "Usługa jest chwilowo niedostępna. Dane lokalne pozostają na urządzeniu.",
      );
    }
    const result = new Response(response.body, response);
    result.headers.set("Content-Security-Policy", CSP);
    result.headers.set("X-Content-Type-Options", "nosniff");
    result.headers.set("Referrer-Policy", "no-referrer");
    result.headers.set(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=(self)",
    );
    result.headers.set("Strict-Transport-Security", "max-age=31536000");
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/health/"))
      result.headers.set("Cache-Control", "no-store");
    if (
      url.pathname === "/sw.js" ||
      url.pathname === "/index.html" ||
      url.pathname === "/"
    )
      result.headers.set("Cache-Control", "no-cache");
    return result;
  },
};
