import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { env } from "../lib/env.js";
import { generateApiKey, hashKey } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

const setup = new Hono();

// First-run setup: generate API key
setup.post("/", async (c) => {
  const body = await c.req.json<{ secret: string }>();

  if (!env.SETUP_SECRET) {
    return c.json({ error: "SETUP_SECRET not configured on server" }, 500);
  }

  if (body.secret !== env.SETUP_SECRET) {
    return c.json({ error: "Invalid setup secret" }, 403);
  }

  const db = getDb();
  const apiKey = generateApiKey();
  const keyHash = hashKey(apiKey);

  // Invalidate all previous keys
  db.prepare("DELETE FROM api_keys").run();

  // Insert new key
  db.prepare("INSERT INTO api_keys (id, key_hash) VALUES (?, ?)").run(
    nanoid(),
    keyHash
  );

  logger.info("New API key generated via setup");

  return c.json({ api_key: apiKey });
});

// Rotate key (requires current valid key — handled by auth middleware upstream)
setup.post("/rotate", async (c) => {
  const db = getDb();
  const apiKey = generateApiKey();
  const keyHash = hashKey(apiKey);

  db.prepare("DELETE FROM api_keys").run();
  db.prepare("INSERT INTO api_keys (id, key_hash) VALUES (?, ?)").run(
    nanoid(),
    keyHash
  );

  logger.info("API key rotated");

  return c.json({ api_key: apiKey });
});

export { setup };
