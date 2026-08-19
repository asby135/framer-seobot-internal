import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  escapeHtml,
  buildDigest,
  chunkText,
  buildKeyboard,
  sendMessage,
  __setTransport,
  TELEGRAM_MAX_CHARS,
} from "./notify.js";

describe("escapeHtml", () => {
  it("escapes the three characters Telegram HTML mode reserves", () => {
    expect(escapeHtml('a < b & c > d')).toBe("a &lt; b &amp; c &gt; d");
  });

  it("escapes ampersands first so entities are not double-encoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Your Sales Team Runs on Telegram")).toBe(
      "Your Sales Team Runs on Telegram"
    );
  });
});

describe("buildDigest", () => {
  it("numbers items so buttons map to positions", () => {
    const out = buildDigest("Titles ready", [{ label: "First" }, { label: "Second" }]);
    expect(out).toContain("1.");
    expect(out).toContain("2.");
  });

  it("includes the header", () => {
    expect(buildDigest("Titles ready", [])).toContain("Titles ready");
  });

  it("escapes item labels so a stray angle bracket cannot break the message", () => {
    expect(buildDigest("H", [{ label: "A < B & C" }])).toContain("&lt;");
  });

  it("renders an optional sub-line under an item", () => {
    const out = buildDigest("H", [{ label: "Title", sub: "web3 → crypto funds" }]);
    expect(out).toContain("web3 → crypto funds");
  });

  it("says so explicitly when there is nothing to review", () => {
    expect(buildDigest("Titles ready", [])).toMatch(/nothing|none|no items/i);
  });
});

describe("chunkText", () => {
  it("returns one chunk when under the limit", () => {
    expect(chunkText("short", 4096)).toEqual(["short"]);
  });

  it("splits oversized text", () => {
    expect(chunkText("x".repeat(5000), 4096)).toHaveLength(2);
  });

  it("loses no characters when splitting", () => {
    const text = "y".repeat(9000);
    expect(chunkText(text, 4096).join("")).toBe(text);
  });

  it("uses Telegram's real 4096 limit by default", () => {
    expect(TELEGRAM_MAX_CHARS).toBe(4096);
  });
});

describe("buildKeyboard", () => {
  it("lays buttons out in rows", () => {
    const kb = buildKeyboard([[{ text: "OK", data: "gen:1" }], [{ text: "No", data: "rej:1" }]]);
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0][0]).toEqual({ text: "OK", callback_data: "gen:1" });
  });

  it("rejects callback data over Telegram's 64-byte cap", () => {
    // Telegram silently drops the button otherwise, so fail loudly at build time.
    expect(() => buildKeyboard([[{ text: "x", data: "a".repeat(65) }]])).toThrow(/64/);
  });
});

describe("sendMessage", () => {
  beforeEach(() => __setTransport(null));

  it("no-ops without throwing when no bot token is configured", async () => {
    const fetchSpy = vi.fn();
    __setTransport({ fetch: fetchSpy, token: "", chatId: "123" });
    await sendMessage("hello");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the Telegram API when configured", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    __setTransport({ fetch: fetchSpy as never, token: "T", chatId: "123" });
    await sendMessage("hello");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/botT/sendMessage");
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: "123", text: "hello" });
  });

  it("does not throw when the Telegram API returns an error", async () => {
    // A failed notification must never take down the nightly run.
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad" }));
    __setTransport({ fetch: fetchSpy as never, token: "T", chatId: "123" });
    await expect(sendMessage("hello")).resolves.toBeUndefined();
  });

  it("does not throw when the network call rejects", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("offline"); });
    __setTransport({ fetch: fetchSpy as never, token: "T", chatId: "123" });
    await expect(sendMessage("hello")).resolves.toBeUndefined();
  });
});
