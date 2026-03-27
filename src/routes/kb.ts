import { Hono } from "hono";
import { loadKB, getKBArticleCount } from "../services/kb.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const kb = new Hono();

// Refresh KB from disk without restart
kb.post("/refresh", (c) => {
  try {
    loadKB(env.KB_PATH);
    const count = getKBArticleCount();
    logger.info({ count }, "KB refreshed");
    return c.json({ status: "refreshed", articles: count });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message }, "KB refresh failed");
    return c.json({ error: message }, 500);
  }
});

// Get KB status
kb.get("/", (c) => {
  return c.json({ articles: getKBArticleCount() });
});

export { kb };
