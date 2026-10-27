import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function initDb(): Database.Database {
  const dbPath = resolve(env.DATABASE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // SQLite performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Run schema
  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  // Migrations — add columns that may not exist in older DBs.
  // Each ALTER is wrapped so an already-applied migration is a no-op, but a
  // genuine failure (locked DB, disk error, corruption) still throws — booting
  // against a half-migrated schema would surface as confusing "no such column"
  // errors at query time instead.
  const addColumn = (sql: string, onFirstAdd?: string) => {
    try {
      // One transaction: if the backfill fails, the ALTER rolls back with it.
      // Otherwise the next boot would see the column, treat the migration as
      // applied, and the backfill would never run.
      db.transaction(() => {
        db.exec(sql);
        // Runs ONLY when the ALTER actually succeeded, i.e. the first time
        // this migration is applied. Putting a backfill outside this block
        // would re-run it on every boot.
        if (onFirstAdd) db.exec(onFirstAdd);
      })();
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
      // Column already exists — migration already applied.
    }
  };
  addColumn("ALTER TABLE article_translations ADD COLUMN slug TEXT");
  addColumn("ALTER TABLE articles ADD COLUMN schema_jsonld TEXT");
  addColumn("ALTER TABLE article_translations ADD COLUMN schema_jsonld TEXT");
  addColumn("ALTER TABLE article_translations ADD COLUMN manual INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE keywords ADD COLUMN niche TEXT");
  addColumn("ALTER TABLE keywords ADD COLUMN proposed_title TEXT");
  addColumn("ALTER TABLE keywords ADD COLUMN bot_message_id INTEGER");
  addColumn("ALTER TABLE api_keys ADD COLUMN label TEXT NOT NULL DEFAULT 'default'");
  addColumn("ALTER TABLE api_keys ADD COLUMN last_used_at TEXT");
  addColumn(
    "ALTER TABLE articles ADD COLUMN announced_at TEXT",
    // Everything already live has effectively been announced. Without this
    // backfill the first deploy after the migration would announce the entire
    // back catalogue.
    "UPDATE articles SET announced_at = published_at WHERE status = 'published'"
  );
  // The generation job a topic is waiting on, as JSON ({query, titleOverride}),
  // or NULL. Makes the in-memory queue survivable: set on enqueue, cleared when
  // the job ends, and replayed at boot. Also the one-job-per-topic guard.
  addColumn("ALTER TABLE keywords ADD COLUMN generation_job TEXT");
  addColumn(
    "ALTER TABLE articles ADD COLUMN ready_at TEXT",
    // When the operator was handed the article at gate 2. Publish all acts only
    // on articles that have it. Rows already sitting in draft/review when this
    // migration runs finished generating long ago — a redeploy kills any job in
    // flight — so they count as shown.
    "UPDATE articles SET ready_at = COALESCE(updated_at, created_at) WHERE status IN ('draft', 'review')"
  );

  logger.info({ path: dbPath }, "Database initialized");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info("Database closed");
  }
}
