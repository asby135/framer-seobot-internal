import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { env } from "../lib/env.js";
import { generateApiKey, hashKey } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

/**
 * API key management.
 *
 * Keys are LABELLED, and minting a label replaces only that label. The earlier
 * design ran `DELETE FROM api_keys` on every mint, so issuing a key for the CLI
 * silently logged the plugin out and vice versa — a footgun rather than a
 * security property once there was more than one consumer.
 *
 * Keys are stored only as SHA-256 hashes, so a minted key is shown exactly once
 * and cannot be recovered afterwards.
 */

const setup = new Hono();

/** Labels are used in URLs and logs; keep them boring. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const DEFAULT_LABEL = "default";

/** Bounded so a scripted loop cannot fill the table with live credentials. */
const MAX_KEYS = 10;

function validLabel(label: unknown): label is string {
  return typeof label === "string" && LABEL_PATTERN.test(label);
}

/** Mint a key for `label`, replacing any existing key under that same label. */
function issueKey(label: string): string {
  const db = getDb();
  const apiKey = generateApiKey();

  db.transaction(() => {
    db.prepare("DELETE FROM api_keys WHERE label = ?").run(label);
    db.prepare("INSERT INTO api_keys (id, key_hash, label) VALUES (?, ?, ?)").run(
      nanoid(),
      hashKey(apiKey),
      label
    );
  })();

  return apiKey;
}

/**
 * First-run setup and re-issue. Public, guarded by SETUP_SECRET, because it is
 * the recovery path when every key is lost.
 */
setup.post("/", async (c) => {
  const body = await c.req
    .json<{ secret?: string; label?: string }>()
    .catch(() => ({}) as { secret?: string; label?: string });

  if (!env.SETUP_SECRET) {
    return c.json({ error: "SETUP_SECRET not configured on server" }, 500);
  }
  if (body.secret !== env.SETUP_SECRET) {
    return c.json({ error: "Invalid setup secret" }, 403);
  }

  const label = body.label ?? DEFAULT_LABEL;
  if (!validLabel(label)) {
    return c.json(
      { error: "label must be 1-32 chars of letters, digits, hyphen or underscore" },
      400
    );
  }

  const db = getDb();
  const existing = db.prepare("SELECT label FROM api_keys WHERE label = ?").get(label);
  if (!existing) {
    const { count } = db.prepare("SELECT COUNT(*) as count FROM api_keys").get() as {
      count: number;
    };
    if (count >= MAX_KEYS) {
      return c.json({ error: `at most ${MAX_KEYS} keys; revoke one first` }, 400);
    }
  }

  const apiKey = issueKey(label);
  logger.info({ label, replaced: Boolean(existing) }, "API key issued");

  return c.json({ api_key: apiKey, label });
});

/**
 * Rotate a key. Protected — the caller proves possession of a valid key.
 * Defaults to rotating the label of the key used to authenticate.
 */
setup.post("/rotate", async (c) => {
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  const label = body.label ?? c.get("apiKeyLabel") ?? DEFAULT_LABEL;

  if (!validLabel(label)) return c.json({ error: "invalid label" }, 400);

  const existing = getDb().prepare("SELECT label FROM api_keys WHERE label = ?").get(label);
  if (!existing) return c.json({ error: `no key labelled "${label}"` }, 404);

  const apiKey = issueKey(label);
  logger.info({ label }, "API key rotated");

  return c.json({ api_key: apiKey, label });
});

/** List labels. Never returns a key or a hash. */
setup.get("/keys", (c) => {
  const rows = getDb()
    .prepare("SELECT label, created_at, last_used_at FROM api_keys ORDER BY label")
    .all() as Array<{ label: string; created_at: string; last_used_at: string | null }>;

  return c.json({ keys: rows });
});

/** Revoke one label, leaving the others working. */
setup.delete("/keys/:label", (c) => {
  const { label } = c.req.param();
  const db = getDb();

  const existing = db.prepare("SELECT label FROM api_keys WHERE label = ?").get(label);
  if (!existing) return c.json({ error: `no key labelled "${label}"` }, 404);

  const { count } = db.prepare("SELECT COUNT(*) as count FROM api_keys").get() as { count: number };
  if (count <= 1) {
    // Revoking the last key locks you out of every protected route, leaving
    // SETUP_SECRET as the only way back in.
    return c.json({ error: "refusing to revoke the last remaining key" }, 409);
  }

  db.prepare("DELETE FROM api_keys WHERE label = ?").run(label);
  logger.info({ label }, "API key revoked");

  return c.json({ success: true, revoked: label });
});

export { setup };
