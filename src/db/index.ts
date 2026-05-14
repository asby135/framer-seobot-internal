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
  const addColumn = (sql: string) => {
    try {
      db.exec(sql);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
      // Column already exists — migration already applied.
    }
  };
  addColumn("ALTER TABLE article_translations ADD COLUMN slug TEXT");
  addColumn("ALTER TABLE articles ADD COLUMN schema_jsonld TEXT");
  addColumn("ALTER TABLE article_translations ADD COLUMN schema_jsonld TEXT");

  logger.info({ path: dbPath }, "Database initialized");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info("Database closed");
  }
}
