import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readConfig, type ApiConfig } from "./config.js";
import { Sessions, TechnicalStore, safeEqual } from "./security.js";
import { NfzService } from "./nfz.js";
import { GroqService, fallbackDraft, type AiAdapter } from "./ai.js";
import { normalizeAudio } from "./audio.js";
import { syntheticFacts, audioFixtureText, type AiFact } from "./fixtures.js";

const audioFixturePath = fileURLToPath(
  new URL("./fixtures/polish-note.wav", import.meta.url),
);
const consentSchema = (purpose: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["provider", "purpose", "approved"],
  properties: {
    provider: { const: "groq" },
    purpose: { const: purpose },
    approved: { type: "boolean" },
  },
});
const factSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sourceId", "text", "allowedForAi", "status"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    sourceId: { type: "string", minLength: 1, maxLength: 80 },
    text: { type: "string", minLength: 1, maxLength: 500 },
    allowedForAi: { const: true },
    status: { const: "confirmed" },
  },
};
const textBody = {
  type: "object",
  additionalProperties: false,
  required: ["consent"],
  properties: {
    consent: consentSchema("text-draft"),
    syntheticId: { type: "string", enum: Object.keys(syntheticFacts) },
    facts: { type: "array", maxItems: 20, items: factSchema },
    purpose: { type: "string", enum: ["care-packet", "note"] },
  },
};
const transcriptionBody = {
  type: "object",
  additionalProperties: false,
  required: ["consent"],
  properties: {
    consent: consentSchema("transcribe"),
    syntheticId: { const: "polish-note" },
    audioBase64: { type: "string", minLength: 4 },
    mimeType: {
      enum: [
        "audio/webm",
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/ogg",
        "audio/ogg;codecs=opus",
        "audio/wav",
        "audio/mpeg",
      ],
    },
    durationSeconds: { type: "number", minimum: 0.01, maximum: 60 },
    previewApproved: { type: "boolean" },
  },
};
const dictionaryQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: 250 },
    page: { type: "integer", minimum: 1, maximum: 10000 },
  },
};
const queuesQuery = {
  type: "object",
  additionalProperties: false,
  required: ["benefit", "locality", "case"],
  properties: {
    benefit: { type: "string", minLength: 2, maxLength: 250 },
    locality: { type: "string", minLength: 2, maxLength: 250 },
    case: { type: "integer", enum: [1, 2] },
    page: { type: "integer", minimum: 1, maximum: 10000 },
  },
};
type Consent = { provider: "groq"; purpose: string; approved: boolean };
interface TextRequest {
  consent: Consent;
  syntheticId?: string;
  facts?: AiFact[];
  purpose?: "care-packet" | "note";
}
interface AudioRequest {
  consent: Consent;
  syntheticId?: string;
  audioBase64?: string;
  mimeType?: string;
  durationSeconds?: number;
  previewApproved?: boolean;
}

export async function buildApi(
  options: {
    config?: ApiConfig;
    fetcher?: typeof fetch;
    ai?: AiAdapter;
    store?: TechnicalStore;
  } = {},
) {
  const config = options.config || readConfig();
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: Math.ceil((config.maxUploadMb * 1024 * 1024 * 4) / 3) + 4096,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const store = options.store || new TechnicalStore(config.budgetDbPath);
  const sessions = new Sessions(config.sessionSecret, store);
  const nfz = new NfzService(config, options.fetcher);
  const ai = options.ai || new GroqService(config, store);
  const aiEnabled =
    config.aiEnabled &&
    Boolean(config.groqApiKey) &&
    Boolean(config.sessionSecret);
  const personalAiEnabled =
    aiEnabled &&
    config.personalAiEnabled &&
    config.appMode === "personal" &&
    Boolean(config.personalAiReviewId);
  const cleanup = setInterval(() => store.cleanup(), 60000);
  cleanup.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    store.close();
  });
  app.setErrorHandler((error, _request, reply) => {
    const code =
      error && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    const status =
      typeof code === "number" && code >= 400 && code < 500 ? code : 500;
    void reply.code(status).send({
      error:
        status === 413
          ? "BODY_TOO_LARGE"
          : status < 500
            ? "INVALID_REQUEST"
            : "INTERNAL_ERROR",
      message:
        status < 500
          ? "Sprawdź dane żądania i spróbuj ponownie."
          : "Nie udało się obsłużyć żądania. Dane lokalne pozostają dostępne.",
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=(self)",
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.appOrigin.startsWith("https:"))
      reply.header("Strict-Transport-Security", "max-age=31536000");
    if (request.url.startsWith("/api/") || request.url.startsWith("/health/"))
      reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin && !config.appOrigins.includes(origin))
      return reply.code(403).send({ error: "ORIGIN_REJECTED" });
    if (request.url.startsWith("/health/")) return;
    if (
      request.url.startsWith("/api/") &&
      !store.rateLimit(`ip:${sessions.hash(request.ip)}`, 120, 60)
    )
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "RATE_LIMIT" });
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (!origin || !config.appOrigins.includes(origin))
        return reply.code(403).send({ error: "ORIGIN_REQUIRED" });
      const session = sessions.read(request.headers.cookie);
      const csrf = request.headers["x-csrf-token"];
      if (
        !session ||
        typeof csrf !== "string" ||
        !safeEqual(csrf, session.csrf)
      )
        return reply.code(403).send({ error: "CSRF_REJECTED" });
      if (
        !store.rateLimit(`paid-session:${session.id}`, 5, 60) ||
        !store.rateLimit(`paid-ip:${sessions.hash(request.ip)}`, 15, 60)
      )
        return reply
          .code(429)
          .header("Retry-After", "60")
          .send({ error: "RATE_LIMIT" });
    }
  });
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = !config.aiEnabled || aiEnabled;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not-ready",
      localConfigurationOnly: true,
      aiConfigured: aiEnabled,
      nfzConfigured: true,
      budgetStore: "ready",
    });
  });
  app.get("/api/capabilities", async (request, reply) => {
    const session =
      sessions.read(request.headers.cookie) || store.createSession();
    reply.header(
      "Set-Cookie",
      `planb_session=${sessions.sign(session.id)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=86400${config.appOrigin.startsWith("https:") ? "; Secure" : ""}`,
    );
    return {
      aiEnabled,
      personalAiEnabled,
      textDraft: aiEnabled,
      transcription: aiEnabled && existsSync(audioFixturePath),
      nfz: true,
      models: { text: config.llmModel, stt: config.sttModel },
      limits: {
        audioSeconds: config.maxAudioSeconds,
        uploadMb: config.maxUploadMb,
      },
      csrfToken: session.csrf,
      syntheticFixtures: Object.entries(syntheticFacts).map(([id, facts]) => ({
        id,
        label: id === "shift-change" ? "Zmiana grafiku" : "Przed konsultacją",
        text: facts.map((f) => f.text).join(" "),
      })),
      audioFixture: {
        id: "polish-note",
        text: audioFixtureText,
        url: "/api/synthetic-audio/polish-note",
      },
      privacy: {
        provider: "Groq",
        personalTransmission: personalAiEnabled
          ? "requires-consent"
          : "disabled",
        retainedByApi: "technical-sessions-and-budget-only",
        providerRetentionReviewed: Boolean(config.personalAiReviewId),
      },
    };
  });
  app.get("/api/synthetic-audio/polish-note", async (_request, reply) => {
    if (!existsSync(audioFixturePath))
      return reply.code(503).send({ error: "SYNTHETIC_AUDIO_UNAVAILABLE" });
    return reply.type("audio/wav").send(readFileSync(audioFixturePath));
  });
  app.post<{ Body: TextRequest }>(
    "/api/text-draft",
    { schema: { body: textBody } },
    async (request, reply) => {
      const body = request.body;
      if (body.syntheticId && body.facts)
        return reply.code(400).send({ error: "MIXED_INPUT" });
      if (!body.syntheticId && (!personalAiEnabled || !body.facts))
        return reply.code(403).send({ error: "PERSONAL_AI_DISABLED" });
      const facts = body.syntheticId
        ? syntheticFacts[body.syntheticId]!
        : body.facts!;
      if (new Set(facts.map((f) => f.id)).size !== facts.length)
        return reply.code(400).send({ error: "DUPLICATE_FACT_ID" });
      const purpose =
        body.purpose ||
        (body.syntheticId === "care-packet" ? "care-packet" : "note");
      if (!body.consent.approved || !aiEnabled)
        return {
          mode: "template",
          draft: fallbackDraft(facts, purpose),
          facts,
          reason: !body.consent.approved ? "CONSENT_REQUIRED" : "AI_DISABLED",
          needsReview: true,
        };
      const result = await ai.draft(facts, purpose);
      return { ...result, facts, needsReview: true };
    },
  );
  app.post<{ Body: AudioRequest }>(
    "/api/transcribe",
    { schema: { body: transcriptionBody } },
    async (request, reply) => {
      const body = request.body;
      if (!body.consent.approved)
        return reply.code(403).send({
          error: "CONSENT_REQUIRED",
          message:
            "Przed wysłaniem potrzebna jest osobna zgoda na całe nagranie.",
        });
      if (!aiEnabled)
        return reply.code(503).send({
          error: "AI_DISABLED",
          message: "Dyktowanie jest wyłączone. Możesz wpisać tekst.",
        });
      if (
        body.syntheticId &&
        (body.audioBase64 || body.mimeType || body.durationSeconds)
      )
        return reply.code(400).send({ error: "MIXED_INPUT" });
      if (!body.syntheticId && !personalAiEnabled)
        return reply.code(403).send({ error: "PERSONAL_AI_DISABLED" });
      if (!body.previewApproved)
        return reply.code(400).send({ error: "AUDIO_PREVIEW_REQUIRED" });
      let bytes: Buffer | undefined;
      try {
        let seconds: number;
        if (body.syntheticId) {
          bytes = readFileSync(audioFixturePath);
          // The generated fixture is PCM mono 16 kHz in our 44-byte WAV container.
          seconds = (bytes.length - 44) / 32000;
        } else {
          if (
            !body.audioBase64 ||
            !body.mimeType ||
            !body.durationSeconds ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audioBase64)
          )
            return reply.code(400).send({ error: "AUDIO_INVALID" });
          const input = Buffer.from(body.audioBase64, "base64");
          if (input.length > config.maxUploadMb * 1024 * 1024) {
            input.fill(0);
            return reply.code(413).send({ error: "AUDIO_TOO_LARGE" });
          }
          try {
            const normalized = await normalizeAudio(
              input,
              config.ffmpegPath,
              config.maxAudioSeconds,
            );
            bytes = normalized.bytes;
            seconds = normalized.seconds;
          } finally {
            input.fill(0);
            body.audioBase64 = "";
          }
        }
        if (seconds > config.maxAudioSeconds || seconds <= 0)
          return reply.code(400).send({ error: "AUDIO_DURATION" });
        const result = await ai.transcribe(bytes, seconds);
        return {
          ...result,
          provider: "Groq",
          needsReview: true,
          synthetic: Boolean(body.syntheticId),
          saved: false,
        };
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "TRANSCRIPTION_UNAVAILABLE";
        const allowed = [
          "DAILY_BUDGET",
          "AUDIO_DURATION",
          "AUDIO_INVALID",
          "AUDIO_DECODER_UNAVAILABLE",
          "AUDIO_DECODE_TIMEOUT",
        ];
        return reply.code(code.startsWith("AUDIO_") ? 400 : 503).send({
          error: allowed.includes(code) ? code : "TRANSCRIPTION_UNAVAILABLE",
          message:
            "Nie udało się zapisać transkrypcji. Wpisz tekst lub świadomie ponów wysyłkę nagrania.",
        });
      } finally {
        bytes?.fill(0);
        body.audioBase64 = "";
      }
    },
  );
  for (const type of ["benefits", "localities"] as const) {
    app.get(
      `/api/care/${type}`,
      { schema: { querystring: dictionaryQuery } },
      async (
        request: FastifyRequest<{ Querystring: { q?: string; page?: number } }>,
        reply,
      ) => {
        try {
          return await nfz.search(type, {
            name: request.query.q || "",
            page: String(request.query.page || 1),
          });
        } catch {
          return reply.code(502).send({
            error: "NFZ_UNAVAILABLE",
            message: "Nie udało się pobrać słownika NFZ. Spróbuj ponownie.",
          });
        }
      },
    );
  }
  app.get<{
    Querystring: {
      benefit: string;
      locality: string;
      case: number;
      page?: number;
    };
  }>(
    "/api/care/queues",
    { schema: { querystring: queuesQuery } },
    async (request, reply) => {
      try {
        return await nfz.search("queues", {
          benefit: request.query.benefit,
          locality: request.query.locality,
          case: String(request.query.case),
          page: String(request.query.page || 1),
        });
      } catch {
        return reply.code(502).send({
          error: "NFZ_UNAVAILABLE",
          message:
            "Nie udało się pobrać placówek. To błąd połączenia, nie brak wyników.",
          sourceUrl: "https://terminyleczenia.nfz.gov.pl/",
        });
      }
    },
  );
  if (config.staticRoot) {
    await app.register(fastifyStatic, {
      root: config.staticRoot,
      wildcard: true,
      dotfiles: "deny",
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url.startsWith("/health/") ||
        request.url.includes(".")
      )
        return reply.code(404).send({ error: "NOT_FOUND" });
      return reply.sendFile("index.html", { cacheControl: false });
    });
  }
  return app;
}
