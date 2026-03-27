import { createHash, randomBytes } from "crypto";
import type { Context, Next } from "hono";
import { getDb } from "../db/index.js";

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

  const row = db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(hash);
  if (!row) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  await next();
}
