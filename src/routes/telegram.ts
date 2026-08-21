import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { answerCallback, alert } from "../services/notify.js";

/**
 * Telegram webhook — the operator's two approval gates.
 *
 * SECURITY: this route cannot sit behind authMiddleware, because Telegram
 * cannot send a bearer token. Two checks stand between the open internet and
 * the generation budget, and both fail closed:
 *
 *   1. X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_WEBHOOK_SECRET
 *   2. the update's chat id must equal TELEGRAM_CHAT_ID
 *
 * An unset secret rejects everything rather than allowing everything, so a
 * missing env var degrades to "bot does not work" instead of "anyone can
 * publish to the live site".
 */

/** Callback actions. Anything not listed here is rejected. */
const ACTIONS = new Set([
  "gen", // approve proposed title → generate
  "rrl", // reroll the proposed title
  "rej", // reject the topic
  "pub", // publish the finished article
  "rgn", // regenerate the article
  "del", // delete the article
  "genall",
  "puball",
]);

export interface ParsedCallback {
  action: string;
  id: string;
}

/**
 * Parse `<action>:<id>`. The id may itself contain colons, so only the first
 * separator is significant — truncating an id would act on the wrong entity.
 */
export function parseCallback(data: string): ParsedCallback | null {
  if (!data) return null;
  const sep = data.indexOf(":");
  if (sep === -1) return null;

  const action = data.slice(0, sep);
  if (!ACTIONS.has(action)) return null;

  return { action, id: data.slice(sep + 1) };
}

/** Constant-time comparison of the webhook secret. Fails closed when unset. */
export function isAuthorized(header: string | undefined, secret: string): boolean {
  if (!secret) return false;
  if (!header) return false;

  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CallbackHandlers {
  onApproveTitle(keywordId: string, messageId: number): Promise<void>;
  onRerollTitle(keywordId: string, messageId: number): Promise<void>;
  onRejectTopic(keywordId: string, messageId: number): Promise<void>;
  onPublish(articleId: string, messageId: number): Promise<void>;
  onRegenerate(articleId: string, messageId: number): Promise<void>;
  onDelete(articleId: string, messageId: number): Promise<void>;
  onApproveAll(messageId: number): Promise<void>;
  onPublishAll(messageId: number): Promise<void>;
}

interface RouteConfig {
  secret: string;
  chatId: string;
  handlers: CallbackHandlers;
  /** Surfaces a handler failure after the callback has been acknowledged. */
  onHandlerError?: (message: string) => Promise<void>;
  /** Tests await the handler; production fires it and returns immediately. */
  awaitHandler?: boolean;
}

interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat?: { id: number } };
  };
}

export function buildTelegramRoute(config: RouteConfig): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!isAuthorized(c.req.header("X-Telegram-Bot-Api-Secret-Token"), config.secret)) {
      logger.warn("Telegram webhook: rejected request with bad or missing secret");
      return c.json({ error: "unauthorized" }, 401);
    }

    const update = await c.req.json<TelegramUpdate>().catch(() => ({}) as TelegramUpdate);
    const cq = update.callback_query;

    // Every path below returns 200. Telegram retries non-2xx responses
    // indefinitely, so a malformed update or a throwing handler would become a
    // permanent retry loop against production.
    if (!cq) return c.json({ ok: true });

    const chatId = cq.message?.chat?.id;
    if (String(chatId) !== config.chatId) {
      logger.warn({ chatId }, "Telegram webhook: update from unauthorized chat ignored");
      return c.json({ ok: true });
    }

    const parsed = parseCallback(cq.data ?? "");
    if (!parsed) {
      logger.warn({ data: cq.data }, "Telegram webhook: unparseable callback");
      return c.json({ ok: true });
    }

    const messageId = cq.message?.message_id ?? 0;
    const h = config.handlers;

    const cb = parsed; // narrowed; the closure below loses the type guard

    const runHandler = async (): Promise<void> => {
      try {
        switch (cb.action) {
          case "gen": await h.onApproveTitle(cb.id, messageId); break;
          case "rrl": await h.onRerollTitle(cb.id, messageId); break;
          case "rej": await h.onRejectTopic(cb.id, messageId); break;
          case "pub": await h.onPublish(cb.id, messageId); break;
          case "rgn": await h.onRegenerate(cb.id, messageId); break;
          case "del": await h.onDelete(cb.id, messageId); break;
          case "genall": await h.onApproveAll(messageId); break;
          case "puball": await h.onPublishAll(messageId); break;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        logger.error({ action: cb.action, id: cb.id, error: message }, "Callback handler failed");
        // The callback is already acknowledged, so a message is the only way
        // left to surface the failure.
        await config.onHandlerError?.(`${cb.action} failed: ${message}`);
      }
    };

    // Acknowledge FIRST, then work.
    //
    // A publish triggers a full collection sync (~10 MB over the Framer API),
    // far longer than Telegram's callback timeout. Awaiting it here means
    // Telegram gives up and redelivers the same update while the first is
    // still running — two concurrent syncs against one collection, interleaving
    // removeItems and addItems. syncToFramer holds a single-flight lock for the
    // same reason.
    // cq.id, NOT cb.id. cb.id is the article/keyword id parsed out of
    // callback_data; the callback QUERY id is Telegram's own and lives on the
    // update. Answering with the wrong one made Telegram reject every single
    // button press with "query is too old and response timeout expired" — its
    // generic reply to an unrecognised callback query id — so the button's
    // spinner never cleared and the update was never acknowledged.
    await answerCallback(cq.id);

    if (config.awaitHandler) await runHandler();
    else void runHandler();

    return c.json({ ok: true });
  });

  return app;
}

/** Production route, reading configuration from the environment. */
export function telegramRoute(handlers: CallbackHandlers): Hono {
  return buildTelegramRoute({
    secret: env.TELEGRAM_WEBHOOK_SECRET,
    chatId: env.TELEGRAM_CHAT_ID,
    handlers,
    onHandlerError: alert,
  });
}
