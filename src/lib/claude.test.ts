import { describe, it, expect } from "vitest";
import { parseJsonReply, thinkingFor, ModelRefusalError, MODELS, requestOptions } from "./claude.js";

const reply = (content: unknown[], stop_reason = "end_turn") => ({ content, stop_reason }) as never;

describe("parseJsonReply", () => {
  it("reads the JSON from text blocks, skipping thinking blocks", () => {
    const out = parseJsonReply<{ a: number }>(
      reply([
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: '{"a":' },
        { type: "text", text: "1}" },
      ])
    );
    expect(out).toEqual({ a: 1 });
  });

  it("throws a typed error on a refusal, with its category", () => {
    const msg = { content: [], stop_reason: "refusal", stop_details: { category: "cyber" } } as never;
    expect(() => parseJsonReply(msg)).toThrow(ModelRefusalError);
    expect(() => parseJsonReply(msg)).toThrow(/cyber/);
  });

  it("refuses a truncated or empty reply instead of returning half an object", () => {
    expect(() => parseJsonReply(reply([{ type: "text", text: '{"a":' }], "max_tokens"))).toThrow(/truncated/);
    expect(() => parseJsonReply(reply([{ type: "thinking", thinking: "" }]))).toThrow(/no text/);
  });
});

describe("thinkingFor", () => {
  it("turns thinking off only where the model allows it", () => {
    expect(thinkingFor("claude-sonnet-5-5", "off")).toEqual({ type: "between_tools" });
    expect(thinkingFor("claude-opus-5-5", "off")).toEqual({ type: "adaptive" });
    expect(thinkingFor("claude-haiku-5-5", "off")).toEqual({ type: "adaptive" });
    expect(thinkingFor("claude-sonnet-5-5", "adaptive")).toEqual({ type: "adaptive" });
  });

  it("never sends the 400-ing disabled setting", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]) {
      for (const mode of ["off", "adaptive"] as const) expect(thinkingFor(m, mode)).not.toEqual({ type: "disabled" });
    }
  });
});

describe("MODELS", () => {
  it("defaults the writer to Sonnet 5.5 and uses current-generation models", () => {
    expect(MODELS.writer).toBe(process.env.ARTICLE_MODEL || "claude-sonnet-5-5");
    expect(MODELS.worker).toBe("claude-sonnet-5-5");
    expect(MODELS.light).toBe("claude-haiku-5-5");
  });
});

describe("requestOptions", () => {
  it("omits unset keys, which the SDK rejects as undefined", () => {
    expect(requestOptions({}, false)).toEqual({});
    expect("timeout" in requestOptions({}, true)).toBe(false);
    expect(requestOptions({ timeoutMs: 30_000, maxRetries: 1 }, false)).toEqual({ timeout: 30_000, maxRetries: 1 });
  });

  it("sends the fallback beta header only when the model supports it", () => {
    expect(requestOptions({}, true)).toEqual({ headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } });
  });
});
