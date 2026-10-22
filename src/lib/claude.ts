import type Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";

/**
 * Which model does which job, in one place.
 *
 * - writer: the article and its revision pass, where quality shows. Runs on
 *   ARTICLE_MODEL (Sonnet 5.5 by default, Opus 5.5 when set).
 * - worker: research, translation, titles, topics, schema repair.
 * - light: short judgements (fact-check against the KB, duplicate topics).
 */
export const MODELS = {
  get writer() {
    return env.ARTICLE_MODEL;
  },
  worker: "claude-sonnet-5-5",
  light: "claude-haiku-5-5",
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The model declined on policy grounds (stop_reason "refusal"). */
export class ModelRefusalError extends Error {
  constructor(public readonly category: string | null) {
    super(`Model refused the request${category ? ` (${category})` : ""}`);
    this.name = "ModelRefusalError";
  }
}

/**
 * Sonnet 5.5 and Opus 5.5 on the Claude API accept a server-side fallback:
 * when a safety classifier declines, the same request is re-run on another
 * model inside the same call. Haiku 5.5 has none.
 */
function supportsFallback(model: string): boolean {
  return /^claude-(opus|sonnet)-5-5$/.test(model);
}

/**
 * The thinking setting for a route. "off" maps to Sonnet 5.5's
 * `between_tools` (its way of turning thinking off; `disabled` is a 400 on
 * the 5.5 models). Opus 5.5 cannot turn thinking off, and Haiku 5.5 is cheap
 * enough to think, so both run adaptive at the route's effort instead.
 */
export function thinkingFor(model: string, mode: "adaptive" | "off"): Record<string, unknown> {
  if (mode === "off" && model.startsWith("claude-sonnet-5-5")) return { type: "between_tools" };
  return { type: "adaptive" };
}

export interface JsonCallParams {
  model: string;
  system: string;
  user: string;
  /** JSON Schema for the reply; every object needs additionalProperties: false. */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort?: Effort;
  thinking?: "adaptive" | "off";
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * One request whose reply is a JSON object matching `schema`.
 *
 * Replaces the forced-tool pattern (`tool_choice: {type: "tool"}`), which the
 * 5.5 models reject with a 400. Structured output guarantees the shape, so
 * callers no longer dig a tool_use block out of the response or regex-repair
 * broken JSON. Streams so a long reply plus thinking never hits the
 * non-streaming HTTP timeout.
 */
export async function callJson<T>(client: Anthropic, p: JsonCallParams): Promise<T> {
  const fallback = supportsFallback(p.model);
  const body = {
    model: p.model,
    max_tokens: p.maxTokens,
    system: p.system,
    messages: [{ role: "user", content: p.user }],
    thinking: thinkingFor(p.model, p.thinking ?? "adaptive"),
    output_config: {
      ...(p.effort ? { effort: p.effort } : {}),
      format: { type: "json_schema", schema: p.schema },
    },
    ...(fallback ? { fallbacks: "default" } : {}),
  };
  const message = await client.messages
    .stream(body as unknown as Anthropic.MessageStreamParams, requestOptions(p, fallback))
    .finalMessage();
  return parseJsonReply<T>(message);
}

/**
 * Per-request options with only the keys that are set: the SDK rejects an
 * explicit `timeout: undefined` ("timeout must be an integer").
 */
export function requestOptions(
  p: Pick<JsonCallParams, "timeoutMs" | "maxRetries">,
  fallback: boolean
): Anthropic.RequestOptions {
  return {
    ...(fallback ? { headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } } : {}),
    ...(p.timeoutMs !== undefined ? { timeout: p.timeoutMs } : {}),
    ...(p.maxRetries !== undefined ? { maxRetries: p.maxRetries } : {}),
  };
}

/** The JSON object in a structured-output reply, after the stop-reason checks. */
export function parseJsonReply<T>(message: Pick<Anthropic.Message, "content" | "stop_reason">): T {
  if (message.stop_reason === "refusal") {
    const details = (message as { stop_details?: { category?: string | null } }).stop_details;
    throw new ModelRefusalError(details?.category ?? null);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Model reply truncated at max_tokens");
  }
  // Thinking blocks may come first; the JSON is in the text blocks.
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error("Model reply had no text");
  return JSON.parse(text) as T;
}
