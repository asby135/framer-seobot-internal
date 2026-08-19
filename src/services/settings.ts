import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

// Tests inject an in-memory database; production reads the real one lazily so
// this module can be imported before initDb() has run.
let testDb: Database.Database | null = null;

export function __setTestDb(db: Database.Database | null): void {
  testDb = db;
}

function db(): Database.Database {
  return testDb ?? getDb();
}

/**
 * Read a JSON setting.
 *
 * Returns `fallback` when the key is missing OR when the stored value fails to
 * parse. A corrupt row must never take the scheduler down — the nightly run
 * degrading to defaults is recoverable, a crash loop on boot is not.
 */
export function getSetting<T>(key: string, fallback: T): T {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;

  try {
    return JSON.parse(row.value) as T;
  } catch {
    logger.warn({ key }, "Corrupt settings value — falling back to default");
    return fallback;
  }
}

/** Write a JSON setting, overwriting any existing value for the key. */
export function setSetting(key: string, value: unknown): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    )
    .run(key, JSON.stringify(value));
}
