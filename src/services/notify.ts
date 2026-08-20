import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * Telegram notifications: the two approval digests and failure alerts.
 *
 * Every send is best-effort. A notification failure must never propagate into
 * the nightly run — losing a digest costs one night of review, whereas an
 * unhandled rejection in the scheduler could wedge the queue.
 */

/** Telegram rejects messages longer than this. */
export const TELEGRAM_MAX_CHARS = 4096;

/** Telegram silently drops buttons whose callback_data exceeds this. */
const MAX_CALLBACK_BYTES = 64;

interface Transport {
  fetch: typeof globalThis.fetch;
  token: string;
  chatId: string;
}

let transport: Transport | null = null;

/** Tests inject a stub transport; production reads env lazily. */
export function __setTransport(t: Transport | null): void {
  transport = t;
}

function getTransport(): Transport {
  return (
    transport ?? {
      fetch: globalThis.fetch,
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    }
  );
}

/** Escape the three characters Telegram's HTML parse mode reserves. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DigestItem {
  label: string;
  /** Optional context line, e.g. "Web3 / crypto → crypto funds → migration". */
  sub?: string;
}

/**
 * Render a numbered digest. Numbering is load-bearing: the inline buttons are
 * labelled by position, so the operator can match button to item at a glance.
 */
export function buildDigest(header: string, items: DigestItem[]): string {
  if (items.length === 0) {
    return `<b>${escapeHtml(header)}</b>\n\nNothing to review.`;
  }

  const lines = items.map((item, i) => {
    const main = `${i + 1}. ${escapeHtml(item.label)}`;
    return item.sub ? `${main}\n    <i>${escapeHtml(item.sub)}</i>` : main;
  });

  return `<b>${escapeHtml(header)}</b>\n\n${lines.join("\n\n")}`;
}

/** Split text into Telegram-sized chunks without losing characters. */
export function chunkText(text: string, limit: number = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

export interface Button {
  text: string;
  data: string;
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/**
 * Build an inline keyboard, failing loudly on oversized callback data.
 * Telegram drops such buttons silently, which would present the operator with
 * a digest whose buttons simply do nothing.
 */
export function buildKeyboard(rows: Button[][]): InlineKeyboard {
  for (const row of rows) {
    for (const b of row) {
      const bytes = Buffer.byteLength(b.data, "utf8");
      if (bytes > MAX_CALLBACK_BYTES) {
        throw new Error(
          `callback_data for "${b.text}" is ${bytes} bytes; Telegram's limit is ${MAX_CALLBACK_BYTES}`
        );
      }
    }
  }
  return {
    inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
  };
}

/**
 * Call the Telegram API.
 *
 * Returns false when the message did not get through, so callers can decide
 * whether that is fatal. Logs Telegram's own `description` — a bare status code
 * is nearly useless here, since 400 covers everything from a wrong chat_id to
 * malformed HTML, and the description names which.
 */
async function call(method: string, body: Record<string, unknown>): Promise<boolean> {
  const { fetch, token } = getTransport();
  if (!token) {
    logger.warn({ method }, "TELEGRAM_BOT_TOKEN not set — notification skipped");
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let description = "";
      try {
        const parsed = (await res.json()) as { description?: string };
        description = parsed.description ?? "";
      } catch {
        description = await res.text().catch(() => "");
      }
      logger.error(
        { method, status: res.status, description, chatId: body.chat_id },
        "Telegram API rejected the request"
      );
      return false;
    }

    return true;
  } catch (e) {
    logger.error(
      { method, error: e instanceof Error ? e.message : "unknown" },
      "Telegram API call failed"
    );
    return false;
  }
}

/** Returns false if any chunk failed to send. */
export async function sendMessage(text: string, keyboard?: InlineKeyboard): Promise<boolean> {
  const { chatId } = getTransport();
  let ok = true;
  for (const chunk of chunkText(text)) {
    const sent = await call("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (!sent) ok = false;
  }
  return ok;
}

/** Edit a message in place, so a tapped button leaves a clean audit trail. */
export async function editMessage(
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  const { chatId } = getTransport();
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/** Acknowledge a button tap so the client stops showing a spinner. */
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
}

/**
 * Send the article as an .html attachment for gate 2.
 *
 * An attachment rather than message text: a 1,500-word article exceeds
 * Telegram's 4,096-character limit several times over, and chunking it
 * destroys the formatting the operator is trying to judge.
 */
export async function sendDocument(
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  const { fetch, token, chatId } = getTransport();
  if (!token) {
    logger.warn({ filename }, "TELEGRAM_BOT_TOKEN not set — document skipped");
    return;
  }

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption.slice(0, 1024)); // Telegram caption limit
    form.append("parse_mode", "HTML");
    form.append("document", new Blob([content], { type: "text/html" }), filename);

    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      logger.error({ filename, status: res.status }, "Telegram sendDocument failed");
    }
  } catch (e) {
    logger.error(
      { filename, error: e instanceof Error ? e.message : "unknown" },
      "Telegram sendDocument threw"
    );
  }
}

/** Failure alert. Deliberately terse so it reads on a phone lock screen. */
export async function alert(message: string): Promise<void> {
  await sendMessage(`⚠️ <b>SEO autopilot</b>\n\n${escapeHtml(message)}`);
}
