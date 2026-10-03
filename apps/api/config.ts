import { resolve } from "node:path";

export interface ApiConfig {
  appOrigin: string;
  appOrigins: string[];
  port: number;
  host: string;
  appMode: "demo" | "personal";
  aiEnabled: boolean;
  personalAiEnabled: boolean;
  groqApiKey: string;
  sessionSecret: string;
  personalAiReviewId: string;
  llmModel: "openai/gpt-oss-120b";
  sttModel: "whisper-large-v3-turbo" | "whisper-large-v3";
  aiTimeoutMs: number;
  sttTimeoutMs: number;
  dailyBudgetUsd: number;
  budgetDbPath: string;
  nfzBaseUrl: string;
  nfzCacheTtlSeconds: number;
  maxUploadMb: number;
  maxAudioSeconds: number;
  staticRoot: string | null;
  ffmpegPath: string;
}
function number(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error("Invalid numeric API configuration");
  return parsed;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const appOrigin = env.APP_ORIGIN || "http://localhost:5181";
  if (new URL(appOrigin).origin !== appOrigin)
    throw new Error("APP_ORIGIN must contain an origin only");
  const appOrigins = [
    ...new Set([
      appOrigin,
      ...(env.ADDITIONAL_APP_ORIGINS || "").split(",").filter(Boolean),
    ]),
  ];
  for (const origin of appOrigins)
    if (
      new URL(origin).origin !== origin ||
      new URL(origin).protocol !== new URL(appOrigin).protocol
    )
      throw new Error(
        "Allowed origins must be exact origins using the same protocol",
      );
  const nfzBaseUrl =
    env.NFZ_BASE_URL || "https://apinfz.nfz.gov.pl/app-itl-api-pcus/";
  if (nfzBaseUrl !== "https://apinfz.nfz.gov.pl/app-itl-api-pcus/")
    throw new Error("NFZ_BASE_URL must use the verified v1.4 endpoint");
  if (env.LLM_MODEL && env.LLM_MODEL !== "openai/gpt-oss-120b")
    throw new Error("Unverified LLM_MODEL");
  if (
    env.STT_MODEL &&
    !["whisper-large-v3-turbo", "whisper-large-v3"].includes(env.STT_MODEL)
  )
    throw new Error("Unverified STT_MODEL");
  const sessionSecret = env.PLANB_SESSION_SECRET || "";
  if (sessionSecret && sessionSecret.length < 32)
    throw new Error("PLANB_SESSION_SECRET must have at least 32 characters");
  if (env.AI_ENABLED === "true" && !sessionSecret)
    throw new Error("AI requires PLANB_SESSION_SECRET injected from psst");
  return {
    appOrigin,
    appOrigins,
    port: number(env.PORT, 8791, 1, 65535),
    host: env.HOST || "127.0.0.1",
    appMode: env.APP_MODE === "personal" ? "personal" : "demo",
    aiEnabled: env.AI_ENABLED === "true",
    personalAiEnabled: env.ALLOW_PERSONAL_DATA_TO_AI === "true",
    groqApiKey: env.GROQ_API_KEY || "",
    sessionSecret,
    personalAiReviewId: env.PERSONAL_AI_REVIEW_ID || "",
    llmModel: "openai/gpt-oss-120b",
    sttModel:
      env.STT_MODEL === "whisper-large-v3"
        ? "whisper-large-v3"
        : "whisper-large-v3-turbo",
    aiTimeoutMs: number(env.AI_TIMEOUT_MS, 10000, 500, 60000),
    sttTimeoutMs: number(env.STT_TIMEOUT_MS, 20000, 500, 60000),
    dailyBudgetUsd: number(env.AI_DAILY_BUDGET_USD, 5, 0, 50),
    budgetDbPath: env.BUDGET_DB_PATH || resolve(".private/budget.sqlite"),
    nfzBaseUrl,
    nfzCacheTtlSeconds: number(env.NFZ_CACHE_TTL_SECONDS, 900, 0, 86400),
    maxUploadMb: number(env.MAX_UPLOAD_MB, 10, 1, 10),
    maxAudioSeconds: number(env.MAX_AUDIO_SECONDS, 60, 1, 60),
    staticRoot:
      env.SERVE_WEB === "true"
        ? resolve(env.WEB_DIST_PATH || "apps/web/dist")
        : null,
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
  };
}
