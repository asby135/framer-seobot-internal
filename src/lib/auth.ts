import { createHash, randomBytes } from "crypto";
import type { Context, Next } from "hono";
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
