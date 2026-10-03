import { afterEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  create: vi.fn(),
  transcribe: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock("groq-sdk", () => ({
  default: class {
    constructor(config: unknown) {
      mocked.constructor(config);
    }
    chat = { completions: { create: mocked.create } };
    audio = { transcriptions: { create: mocked.transcribe } };
  },
  toFile: async () => ({ name: "approved-note.wav" }),
}));
import { GroqService, fallbackDraft } from "./ai.js";
import { readConfig } from "./config.js";
import { TechnicalStore } from "./security.js";
import { syntheticFacts } from "./fixtures.js";
const stores: TechnicalStore[] = [];
function service(budget = 1) {
  const store = new TechnicalStore(":memory:");
  stores.push(store);
  return {
    service: new GroqService(
      {
        ...readConfig({}),
        aiEnabled: true,
        groqApiKey: "not-a-key",
        dailyBudgetUsd: budget,
      },
      store,
    ),
    store,
  };
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.clearAllMocks();
});
describe("Groq failure and strict-output boundaries", () => {
  it("uses strict JSON without tools or streaming, no automatic retries and only fact allowlist", async () => {
    const { service: ai } = service();
    const facts = syntheticFacts["shift-change"]!;
    mocked.create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(fallbackDraft(facts, "note")) },
        },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 20 },
    });
    expect((await ai.draft(facts, "note")).mode).toBe("ai");
    expect(mocked.constructor).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, timeout: 10000 }),
    );
    const request = mocked.create.mock.calls[0]![0];
    expect(request).toMatchObject({
      model: "openai/gpt-oss-120b",
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { strict: true, schema: { additionalProperties: false } },
      },
    });
    expect(request.tools).toBeUndefined();
    expect(
      Object.keys(JSON.parse(request.messages[1].content).facts[0]).sort(),
    ).toEqual(["id", "sourceId", "text"]);
  });
  it.each(["timeout", "429", "503"])(
    "falls back on %s without retry or leaking provider error text",
    async (reason) => {
      const { service: ai, store } = service();
      mocked.create.mockRejectedValueOnce(
        new Error(`${reason}: sensitive upstream diagnostic`),
      );
      const result = await ai.draft(syntheticFacts["shift-change"]!, "note");
      expect(result).toMatchObject({
        mode: "template",
        reason: "PROVIDER_UNAVAILABLE",
      });
      expect(mocked.create).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(store.consumed()).toBe(0.03);
    },
  );
  it("rejects source hallucination and successful-but-truncated responses", async () => {
    const { service: ai } = service();
    const facts = syntheticFacts["shift-change"]!;
    mocked.create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              ...fallbackDraft(facts, "note"),
              sourceIds: ["invented"],
            }),
          },
        },
      ],
    });
    expect(await ai.draft(facts, "note")).toMatchObject({
      mode: "template",
      reason: "INVALID_MODEL_RESULT",
    });
    mocked.create.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "length",
          message: { content: JSON.stringify(fallbackDraft(facts, "note")) },
        },
      ],
    });
    expect(await ai.draft(facts, "note")).toMatchObject({
      mode: "template",
      reason: "INVALID_MODEL_RESULT",
    });
  });
  it("rejects budget exhaustion before provider call", async () => {
    const { service: ai } = service(0.01);
    expect(
      await ai.draft(syntheticFacts["shift-change"]!, "note"),
    ).toMatchObject({ mode: "template", reason: "DAILY_BUDGET" });
    expect(mocked.create).not.toHaveBeenCalled();
  });
});
