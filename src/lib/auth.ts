import { createHash, randomBytes } from "crypto";
import type { Context, Hono, Next } from "hono";
import { getDb } from "../db/index.js";

declare module "hono" {
  interface ContextVariableMap {
    /** Label of the API key that authenticated the request. */
    apiKeyLabel: string;
  }
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  return randomBytes(32).toString("base64url");
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice(7);
  const hash = hashKey(key);
  const db = getDb();

  const row = db.prepare("SELECT id, label FROM api_keys WHERE key_hash = ?").get(hash) as
    | { id: string; label: string }
    | undefined;
  if (!row) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Expose the label so /api/setup/rotate can default to rotating the key the
  // caller actually used, rather than guessing.
  c.set("apiKeyLabel", row.label);

  // Track usage so a stale key can be identified before revoking it. Traffic is
  // a handful of requests a day, so a write per request costs nothing here.
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);

  await next();
}

/**
 * Every path that demands a bearer key. Each entry covers the path itself and
 * everything below it.
 *
 * Public by design, and therefore absent: /api/status, POST /api/setup (gated
 * by SETUP_SECRET — it is how the first key is minted) and /api/telegram
 * (Telegram cannot send a bearer token; it authenticates on its secret-token
 * header and a chat allowlist).
 *
 * /api/setup is listed path by path rather than as a prefix because a prefix
 * would also cover POST /api/setup and lock out first-time setup. Listing it
 * by hand is how /api/setup/keys was missed: it shipped public, so anyone could
 * list key labels and revoke the plugin's key.
 */
const PROTECTED_PATHS = [
  "/api/setup/rotate",
  "/api/setup/keys",
  "/api/topics",
  "/api/articles",
  "/api/generate",
  "/api/sync",
  "/api/schema",
  "/api/research",
  "/api/kb",
  "/api/settings",
  "/api/autopilot",
];

/**
 * Mount authMiddleware on every protected path. Call before mounting routes.
 * In Hono 4 "/x/*" also matches "/x" itself, so one pattern per path covers
 * both — mounting both ran the key lookup twice per request.
 */
export function applyAuth(app: Hono): void {
  for (const path of PROTECTED_PATHS) app.use(`${path}/*`, authMiddleware);
}
