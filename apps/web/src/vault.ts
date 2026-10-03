import Dexie, { type Table } from "dexie";
import { z } from "zod";
import {
  domainDataSchema,
  isoDateTimeSchema,
  timezoneSchema,
  type DomainData,
} from "@planb/domain";
export interface Attachment {
  id: string;
  sourceId: string;
  name: string;
  mimeType: string;
  base64: string;
}
export interface AppData extends DomainData {
  schemaVersion: 1;
  attachments: Attachment[];
  importedKeys: string[];
  importBatches?: import("@planb/importers").ConfirmedImportBatch[];
  reminders: boolean;
  calendarImportState?: {
    records: {
      id: string;
      sourceId: string;
      uid: string;
      recurrenceId?: string;
      version: number;
      originalTimezone?: string;
    }[];
    cancellations: {
      sourceId: string;
      uid: string;
      recurrenceId?: string;
      version: number;
    }[];
    series?: { sourceId: string; uid: string; version: number }[];
  };
  observationImportState?: {
    records: import("@planb/importers").ObservationRecord[];
    resolutions: {
      id: string;
      metric: string;
      sourceKey: string;
      recordIds: string[];
      resolvedAt: string;
    }[];
  };
  documentPages?: {
    sourceId: string;
    page: number;
    text: string;
    extraction: "text" | "ocr";
    confidence?: number;
    imageAttachmentId?: string;
  }[];
  documentFactMetadata?: {
    id: string;
    originalText: string;
    extraction: "text" | "ocr";
    confidence?: number;
    referenceRange?: string;
    date?: string;
    numericValue?: number;
  }[];
}
export interface Envelope {
  format: "planb-vault";
  version: 1;
  kdf: { name: "PBKDF2"; iterations: number; salt: string };
  iv: string;
  ciphertext: string;
  generation: number;
}
interface RecordRow {
  id: string;
  envelope: Envelope;
}
export class VaultDb extends Dexie {
  records!: Table<RecordRow, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ records: "id" });
  }
}
const bytes = (data: Uint8Array) => new Uint8Array(data).buffer;
export function toBase64(data: Uint8Array) {
  let result = "";
  for (let i = 0; i < data.length; i += 8192)
    result += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(result);
}
export function fromBase64(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
const salt = () => toBase64(crypto.getRandomValues(new Uint8Array(16)));
async function derive(phrase: string, kdf: Envelope["kdf"]) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(phrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytes(fromBase64(kdf.salt)),
      iterations: kdf.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
function validateEnvelope(value: unknown): asserts value is Envelope {
  const e = value as Envelope;
  if (
    !e ||
    e.format !== "planb-vault" ||
    e.version !== 1 ||
    e.kdf?.name !== "PBKDF2" ||
    !Number.isInteger(e.kdf.iterations) ||
    e.kdf.iterations < 100000 ||
    e.kdf.iterations > 2000000 ||
    !Number.isSafeInteger(e.generation) ||
    e.generation < 0 ||
    typeof e.ciphertext !== "string" ||
    e.ciphertext.length > 200000000 ||
    fromBase64(e.iv).length !== 12 ||
    fromBase64(e.kdf.salt).length !== 16
  )
    throw Error("Nieobsługiwana lub uszkodzona kopia sejfu.");
}
const identifier = z.string().min(1).max(500),
  version = z.number().int().nonnegative(),
  confidence = z.number().finite().min(0).max(100).optional();
const calendarLedger = z.object({
  originalTimezone: z.string().optional(),
  sourceId: identifier,
  uid: identifier,
  recurrenceId: z.string().optional(),
  version,
});
const importMetadataSchema = z.object({
  importBatches: z
    .array(
      z.object({
        id: identifier,
        sourceId: identifier,
        hash: identifier,
        parserVersion: identifier,
        status: z.literal("confirmed"),
        allowedUse: z.literal("local_only"),
        configuration: z.object({
          timezone: timezoneSchema.optional(),
          calendarKind: z.enum(["work", "rest", "busy"]).optional(),
          delimiter: z.string().max(10).optional(),
          csvMapping: z
            .partialRecord(
              z.enum([
                "source",
                "external_id",
                "metric",
                "start",
                "end",
                "timezone",
                "value",
                "unit",
                "version",
              ]),
              z.string().max(500),
            )
            .optional(),
        }),
        configurationKey: identifier,
        confirmedAt: isoDateTimeSchema,
        range: z
          .object({ start: isoDateTimeSchema, end: isoDateTimeSchema })
          .refine((r) => Date.parse(r.end) >= Date.parse(r.start))
          .optional(),
        counts: z.object({
          calendar: version,
          cancellations: version,
          observations: version,
          facts: version,
          pages: version,
        }),
        recordIds: z.object({
          calendar: z.array(identifier),
          observations: z.array(identifier),
          facts: z.array(identifier),
          cancellations: z.array(z.string()),
          series: z.array(identifier),
        }),
        sourceRevision: version,
        replacesBatchIds: z.array(identifier),
        supersededAt: isoDateTimeSchema.optional(),
      }),
    )
    .optional(),
  calendarImportState: z
    .object({
      records: z.array(calendarLedger.extend({ id: identifier })),
      cancellations: z.array(calendarLedger),
      series: z.array(calendarLedger.omit({ recurrenceId: true })).optional(),
    })
    .optional(),
  observationImportState: z
    .object({
      records: z.array(
        z
          .object({
            id: identifier,
            sourceId: identifier,
            sourceName: z.string(),
            externalId: z.string(),
            version,
            sourceVersion: version.optional(),
            metric: identifier,
            start: isoDateTimeSchema,
            end: isoDateTimeSchema,
            timezone: timezoneSchema,
            originalLocal: z.string(),
            value: z.number().finite(),
            unit: z.string(),
            originalValue: z.string(),
            originalUnit: z.string(),
            status: z.enum(["pending", "confirmed", "rejected"]),
            activityType: z.string().optional(),
            primary: z.boolean().optional(),
          })
          .refine((r) => Date.parse(r.end) >= Date.parse(r.start)),
      ),
      resolutions: z.array(
        z.object({
          id: identifier,
          metric: identifier,
          sourceKey: z.string(),
          recordIds: z.array(identifier),
          resolvedAt: isoDateTimeSchema,
        }),
      ),
    })
    .optional(),
  documentPages: z
    .array(
      z.object({
        sourceId: identifier,
        page: z.number().int().positive(),
        text: z.string(),
        extraction: z.enum(["text", "ocr"]),
        confidence,
        imageAttachmentId: identifier.optional(),
      }),
    )
    .optional(),
  documentFactMetadata: z
    .array(
      z.object({
        id: identifier,
        originalText: z.string(),
        extraction: z.enum(["text", "ocr"]),
        confidence,
        referenceRange: z.string().optional(),
        date: z.string().optional(),
        numericValue: z.number().finite().optional(),
      }),
    )
    .optional(),
});
function validateData(value: unknown): asserts value is AppData {
  const d = value as AppData;
  if (
    !d ||
    d.schemaVersion !== 1 ||
    !domainDataSchema.safeParse(d).success ||
    !importMetadataSchema.safeParse(d).success ||
    !Array.isArray(d.attachments) ||
    d.attachments.some(
      (a) =>
        !a ||
        typeof a.id !== "string" ||
        typeof a.sourceId !== "string" ||
        typeof a.name !== "string" ||
        typeof a.mimeType !== "string" ||
        typeof a.base64 !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64),
    ) ||
    !Array.isArray(d.importedKeys) ||
    d.importedKeys.some((k) => typeof k !== "string") ||
    typeof d.reminders !== "boolean"
  )
    throw Error(
      "Nieobsługiwana lub uszkodzona wersja danych. Oryginalny sejf został zachowany.",
    );
}
async function seal(
  data: AppData,
  key: CryptoKey,
  kdf: Envelope["kdf"],
  generation: number,
): Promise<Envelope> {
  validateData(data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`planb-vault:1:${generation}`);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return {
    format: "planb-vault",
    version: 1,
    kdf,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
    generation,
  };
}
async function unseal(envelope: Envelope, key: CryptoKey) {
  let decoded: unknown;
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes(fromBase64(envelope.iv)),
        additionalData: new TextEncoder().encode(
          `planb-vault:1:${envelope.generation}`,
        ),
      },
      key,
      bytes(fromBase64(envelope.ciphertext)),
    );
    decoded = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw Error(
      "Nieprawidłowa fraza albo uszkodzona kopia. Dane nie zostały zmienione.",
    );
  }
  validateData(decoded);
  return decoded;
}
export class Vault {
  db: VaultDb;
  private key?: CryptoKey;
  private envelope?: Envelope;
  constructor(public mode: "demo" | "personal") {
    this.db = new VaultDb(`planb-${mode}`);
  }
  async exists() {
    return Boolean(await this.db.records.get("vault"));
  }
  async create(phrase: string, data: AppData) {
    if (phrase.length < 12)
      throw Error("Fraza musi mieć co najmniej 12 znaków.");
    if (await this.exists())
      throw Error("Sejf już istnieje. Odblokuj go albo odtwórz kopię.");
    const kdf: Envelope["kdf"] = {
      name: "PBKDF2",
      iterations: 600000,
      salt: salt(),
    };
    const key = await derive(phrase, kdf);
    const env = await seal(data, key, kdf, 0);
    await this.db.records.add({ id: "vault", envelope: env });
    this.key = key;
    this.envelope = env;
    return data;
  }
  async unlock(phrase: string) {
    const row = await this.db.records.get("vault");
    if (!row) throw Error("Brak sejfu na tym urządzeniu.");
    validateEnvelope(row.envelope);
    const key = await derive(phrase, row.envelope.kdf);
    const data = await unseal(row.envelope, key);
    this.key = key;
    this.envelope = row.envelope;
    return data;
  }
  async save(data: AppData) {
    if (!this.key || !this.envelope) throw Error("Sejf jest zablokowany.");
    const generation = this.envelope.generation;
    const env = await seal(data, this.key, this.envelope.kdf, generation + 1);
    await this.db.transaction("rw", this.db.records, async () => {
      const current = await this.db.records.get("vault");
      if (!current || current.envelope.generation !== generation)
        throw Error(
          "Dane zmieniły się w drugiej karcie. Odblokuj sejf ponownie i przelicz plan.",
        );
      await this.db.records.put({ id: "vault", envelope: env });
    });
    this.envelope = env;
  }
  async export() {
    const row = await this.db.records.get("vault");
    if (!row) throw Error("Nie ma danych do skopiowania.");
    return JSON.stringify(row.envelope);
  }
  async restore(text: string, phrase: string) {
    let env: Envelope;
    try {
      env = JSON.parse(text);
      validateEnvelope(env);
    } catch {
      throw Error("Nieobsługiwana lub uszkodzona kopia sejfu.");
    }
    const key = await derive(phrase, env.kdf);
    const data = await unseal(env, key);
    if (data.profile.mode !== this.mode)
      throw Error(
        "Kopia należy do innego trybu. Dane demo i własne są oddzielone.",
      );
    const current = await this.db.records.get("vault");
    const generation = (current?.envelope.generation ?? -1) + 1;
    const restored = await seal(data, key, env.kdf, generation);
    await this.db.transaction("rw", this.db.records, async () => {
      const latest = await this.db.records.get("vault");
      if (latest?.envelope.generation !== current?.envelope.generation)
        throw Error("Sejf zmienił się podczas odtwarzania. Spróbuj ponownie.");
      await this.db.records.put({ id: "vault", envelope: restored });
    });
    this.key = key;
    this.envelope = restored;
    return data;
  }
  async changePhrase(oldPhrase: string, newPhrase: string) {
    if (newPhrase.length < 12)
      throw Error("Nowa fraza musi mieć co najmniej 12 znaków.");
    const data = await this.unlock(oldPhrase);
    const current = this.envelope!;
    const kdf: Envelope["kdf"] = {
      name: "PBKDF2",
      iterations: 600000,
      salt: salt(),
    };
    const key = await derive(newPhrase, kdf);
    const env = await seal(data, key, kdf, current.generation + 1);
    await this.db.transaction("rw", this.db.records, async () => {
      if (
        (await this.db.records.get("vault"))?.envelope.generation !==
        current.generation
      )
        throw Error("Sejf zmienił się w drugiej karcie.");
      await this.db.records.put({ id: "vault", envelope: env });
    });
    this.key = key;
    this.envelope = env;
  }
  lock() {
    this.key = undefined;
    this.envelope = undefined;
  }
  async remove() {
    this.lock();
    await this.db.records.clear();
  }
}
