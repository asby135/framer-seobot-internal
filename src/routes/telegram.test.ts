import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCallback, isAuthorized, buildTelegramRoute, type CallbackHandlers } from "./telegram.js";

describe("parseCallback", () => {
  it("splits action and id", () => {
    expect(parseCallback("pub:abc123")).toEqual({ action: "pub", id: "abc123" });
  });

  it("accepts bulk actions with no id", () => {
    expect(parseCallback("puball:")).toEqual({ action: "puball", id: "" });
  });

  it("rejects an unknown action", () => {
    expect(parseCallback("drop:abc")).toBeNull();
  });

  it("rejects malformed data with no separator", () => {
    expect(parseCallback("garbage")).toBeNull();
  });

  it("rejects empty data", () => {
    expect(parseCallback("")).toBeNull();
  });

  it("keeps ids containing a colon intact", () => {
    // nanoid can emit '-' and '_' but ids are opaque; never truncate them.
    expect(parseCallback("pub:a:b")).toEqual({ action: "pub", id: "a:b" });
  });
});

describe("isAuthorized", () => {
  const secret = "s3cret";

  it("accepts a request with the correct secret header", () => {
    expect(isAuthorized(secret, secret)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(isAuthorized("wrong", secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAuthorized(undefined, secret)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    // Fail closed: an unconfigured secret must not mean "allow all", or a
    // missing env var would expose the generation budget to the internet.
    expect(isAuthorized("anything", "")).toBe(false);
    expect(isAuthorized(undefined, "")).toBe(false);
  });
});

describe("webhook route", () => {
  const SECRET = "s3cret";
  const CHAT = "42";
  let handlers: CallbackHandlers;

  const post = (body: unknown, secret: string | null = SECRET) =>
    buildTelegramRoute({ secret: SECRET, chatId: CHAT, handlers }).request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret }),
      },
      body: JSON.stringify(body),
    });

  const callback = (data: string, chatId = CHAT) => ({
    callback_query: {
      id: "cb1",
      data,
      message: { message_id: 7, chat: { id: Number(chatId) } },
    },
  });

  beforeEach(() => {
    handlers = {
      onApproveTitle: vi.fn(async () => {}),
      onRerollTitle: vi.fn(async () => {}),
      onRejectTopic: vi.fn(async () => {}),
      onPublish: vi.fn(async () => {}),
      onRegenerate: vi.fn(async () => {}),
      onDelete: vi.fn(async () => {}),
      onApproveAll: vi.fn(async () => {}),
      onPublishAll: vi.fn(async () => {}),
    };
  });

  it("rejects a request with a wrong secret", async () => {
    const res = await post(callback("pub:1"), "nope");
    expect(res.status).toBe(401);
    expect(handlers.onPublish).not.toHaveBeenCalled();
  });

  it("rejects a request with no secret header at all", async () => {
    const res = await post(callback("pub:1"), null);
    expect(res.status).toBe(401);
  });

  it("ignores an update from an unknown chat", async () => {
    const res = await post(callback("pub:1", "999"));
    expect(res.status).toBe(200);
    expect(handlers.onPublish).not.toHaveBeenCalled();
  });

  it("routes an authorized publish callback to its handler", async () => {
    const res = await post(callback("pub:art1"));
    expect(res.status).toBe(200);
    expect(handlers.onPublish).toHaveBeenCalledWith("art1", 7);
  });

  it("routes a title approval to its handler", async () => {
    await post(callback("gen:kw1"));
    expect(handlers.onApproveTitle).toHaveBeenCalledWith("kw1", 7);
  });

  it("routes bulk actions", async () => {
    await post(callback("puball:"));
    expect(handlers.onPublishAll).toHaveBeenCalled();
  });

  it("returns 200 for an unparseable callback rather than erroring", async () => {
    // Telegram retries non-2xx responses; a malformed update would retry forever.
    const res = await post(callback("garbage"));
    expect(res.status).toBe(200);
  });

  it("returns 200 for a non-callback update", async () => {
    const res = await post({ message: { text: "hi", chat: { id: Number(CHAT) } } });
    expect(res.status).toBe(200);
  });

  it("returns 200 when a handler throws, so Telegram does not retry forever", async () => {
    handlers.onPublish = vi.fn(async () => {
      throw new Error("db locked");
    });
    const res = await post(callback("pub:art1"));
    expect(res.status).toBe(200);
  });
});
