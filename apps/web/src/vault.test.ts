import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptRevision,
  createDemoData,
  createEmptyData,
  createRepairInput,
  repairPlan,
} from "@planb/domain";
import {
  fromBase64,
  toBase64,
  Vault,
  type AppData,
  type Envelope,
} from "./vault";

const phrase = "Moja testowa fraza 2026",
  now = "2026-10-03T10:00:00Z";
const instances: Vault[] = [];
const vault = (mode: "personal" | "demo" = "personal") => {
  const value = new Vault(mode);
  instances.push(value);
  return value;
};
const personal = (): AppData => ({
  ...createEmptyData(),
  schemaVersion: 1,
  attachments: [
    {
      id: "attachment-one",
      sourceId: "source-one",
      name: "prywatna-notatka.txt",
      mimeType: "text/plain",
      base64: btoa("TRESC PRYWATNA 12345"),
    },
  ],
  importedKeys: [],
  reminders: false,
});
const demo = (): AppData => ({
  ...createDemoData(now),
  schemaVersion: 1,
  attachments: [],
  importedKeys: [],
  reminders: false,
});
beforeEach(async () => {
  await Dexie.delete("planb-personal");
  await Dexie.delete("planb-demo");
});
afterEach(async () => {
  for (const value of instances.splice(0)) {
    value.lock();
    value.db.close();
  }
  await Dexie.delete("planb-personal");
  await Dexie.delete("planb-demo");
});

/** Produce an authenticated but structurally invalid old backup to exercise migration validation. */
async function replaceEncryptedData(
  text: string,
  data: unknown,
): Promise<string> {
  const envelope = JSON.parse(text) as Envelope;
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(phrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(fromBase64(envelope.kdf.salt)).buffer,
      iterations: envelope.kdf.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(
        `planb-vault:1:${envelope.generation}`,
      ),
    },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return JSON.stringify({
    ...envelope,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  });
}

describe("encrypted local vault", () => {
  it("persists AES-GCM ciphertext and technical identifiers without plaintext or the phrase", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    const records = await store.db.records.toArray();
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!).sort()).toEqual(["envelope", "id"]);
    const exported = await store.export();
    expect(exported).not.toContain(phrase);
    expect(exported).not.toContain("prywatna-notatka");
    expect(exported).not.toContain("TRESC PRYWATNA");
    expect(exported).not.toContain(data.attachments[0]!.base64);
    store.lock();
    expect(await store.unlock(phrase)).toEqual(data);
  });
  it("uses a fresh IV on every save and monotonically advances the transaction generation", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    const one = JSON.parse(await store.export()) as Envelope;
    await store.save(data);
    const two = JSON.parse(await store.export()) as Envelope;
    await store.save(data);
    const three = JSON.parse(await store.export()) as Envelope;
    expect(new Set([one.iv, two.iv, three.iv]).size).toBe(3);
    expect([one.generation, two.generation, three.generation]).toEqual([
      0, 1, 2,
    ]);
    expect(one.kdf.salt).toBe(two.kdf.salt);
    expect(one.ciphertext).not.toBe(two.ciphertext);
  });
  it("rejects a wrong phrase for unlock or restore without changing the current vault", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    const before = await store.export();
    store.lock();
    await expect(store.unlock("To jest zła fraza")).rejects.toThrow(
      "Nieprawidłowa fraza",
    );
    await expect(store.restore(before, "To także zła fraza")).rejects.toThrow(
      "Nieprawidłowa fraza",
    );
    expect(await store.export()).toBe(before);
    expect(await store.unlock(phrase)).toEqual(data);
  });
  it("rejects altered ciphertext, authenticated generation and unsupported backup versions", async () => {
    const store = vault();
    await store.create(phrase, personal());
    const before = await store.export();
    const original = JSON.parse(before) as Envelope;
    const altered = fromBase64(original.ciphertext);
    altered[10] = altered[10]! ^ 1;
    for (const broken of [
      { ...original, ciphertext: toBase64(altered) },
      { ...original, generation: original.generation + 1 },
      { ...original, version: 2 },
      { ...original, kdf: { ...original.kdf, iterations: 999999999 } },
    ]) {
      await expect(
        store.restore(JSON.stringify(broken), phrase),
      ).rejects.toThrow();
      expect(await store.export()).toBe(before);
    }
  });
  it("preserves the original vault if an authenticated backup has an unsupported schema or malformed nested data", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    const before = await store.export();
    for (const broken of [
      { ...data, schemaVersion: 99 },
      { ...data, profile: { ...data.profile, timezone: "Unknown/Place" } },
      {
        ...data,
        constraints: [
          {
            id: "broken",
            kind: "max_duration",
            mappingState: "confirmed",
            maxDurationMinutes: -100,
          },
        ],
      },
      { ...data, attachments: [{ id: "broken" }] },
      { ...data, reminders: "yes" },
      {
        ...data,
        calendarImportState: {
          records: [],
          cancellations: [{ sourceId: "s", uid: "u", version: -1 }],
        },
      },
      {
        ...data,
        observationImportState: {
          records: [{ metric: "weight", value: "bad" }],
          resolutions: [],
        },
      },
      {
        ...data,
        documentPages: [
          { sourceId: "s", page: -2, text: "", extraction: "ocr" },
        ],
      },
      {
        ...data,
        documentFactMetadata: [
          { id: "f", originalText: "", extraction: "unknown" },
        ],
      },
    ]) {
      await expect(
        store.restore(await replaceEncryptedData(before, broken), phrase),
      ).rejects.toThrow();
      expect(await store.export()).toBe(before);
    }
  });
  it("prevents a lost update across two tabs with the same generation", async () => {
    const one = vault(),
      two = vault(),
      data = personal();
    await one.create(phrase, data);
    await two.unlock(phrase);
    const result = await Promise.allSettled([
      one.save({ ...data, revision: 1, reminders: true }),
      two.save({ ...data, revision: 2, reminders: false }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    const winner = await one.unlock(phrase);
    expect([1, 2]).toContain(winner.revision);
    expect(winner.reminders).toBe(winner.revision === 1);
  });
  it("restores a verified copy after edits and preserves monotonic generations", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    const backup = await store.export();
    await store.save({ ...data, revision: 3, reminders: true });
    const before = JSON.parse(await store.export()) as Envelope;
    expect(await store.restore(backup, phrase)).toEqual(data);
    const after = JSON.parse(await store.export()) as Envelope;
    expect(after.generation).toBeGreaterThan(before.generation);
    store.lock();
    expect(await store.unlock(phrase)).toEqual(data);
  });
  it("changes the phrase transactionally with fresh salt and keeps every record", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    const before = JSON.parse(await store.export()) as Envelope;
    await store.changePhrase(phrase, "Całkiem nowa dobra fraza");
    const after = JSON.parse(await store.export()) as Envelope;
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(after.generation).toBe(before.generation + 1);
    store.lock();
    await expect(store.unlock(phrase)).rejects.toThrow("Nieprawidłowa fraza");
    expect(await store.unlock("Całkiem nowa dobra fraza")).toEqual(data);
  });
  it("isolates demo from personal data during restore and deletion", async () => {
    const own = vault(),
      synthetic = vault("demo");
    await own.create(phrase, personal());
    await synthetic.create(phrase, demo());
    const ownBefore = await own.export(),
      demoBackup = await synthetic.export();
    await expect(own.restore(demoBackup, phrase)).rejects.toThrow(
      "innego trybu",
    );
    expect(await own.export()).toBe(ownBefore);
    await synthetic.remove();
    expect(await synthetic.exists()).toBe(false);
    expect(await own.exists()).toBe(true);
    expect(await own.export()).toBe(ownBefore);
  });
  it("keeps a repeated accepted operation idempotent after encryption and reopening", async () => {
    const store = vault("demo"),
      data = demo(),
      input = createRepairInput(data, "plan-main", now),
      result = repairPlan(input);
    const request = {
      operationId: "double-click",
      expectedRevision: data.revision,
      input,
      result,
      now,
      choice: {
        kind: "activity" as const,
        candidateId: result.candidates[0]!.id,
      },
    };
    await store.create(phrase, data);
    const accepted = acceptRevision(data, request);
    await store.save(accepted);
    store.lock();
    const reopened = await store.unlock(phrase),
      repeated = acceptRevision(reopened, request);
    await store.save(repeated);
    expect(
      repeated.decisions.filter((d) => d.operationId === request.operationId),
    ).toHaveLength(1);
    expect(repeated.revision).toBe(accepted.revision);
  });
  it("rejects writes after lock and removes encrypted records on explicit deletion", async () => {
    const store = vault(),
      data = personal();
    await store.create(phrase, data);
    store.lock();
    await expect(store.save(data)).rejects.toThrow("zablokowany");
    await store.remove();
    expect(await store.db.records.count()).toBe(0);
    await expect(store.unlock(phrase)).rejects.toThrow("Brak sejfu");
  });
});
