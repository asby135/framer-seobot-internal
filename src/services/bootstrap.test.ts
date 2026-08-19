import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * bootstrap.ts is the only place the unit-tested pieces meet a real database,
 * so it is the only place a SQL-level bug can hide. It hid one: the delete
 * handlers removed the parent row before its children, which throws under
 * `foreign_keys = ON` — 100% of the time, since every generated article has a
 * thumbnail asset and a translation row.
 *
 * These tests use a real SQLite database rather than mocks, because mocking
 * the database is precisely what let the bug through.
 */

let buildGateHandlers: typeof import("./bootstrap.js").buildGateHandlers;
let getDb: typeof import("../db/index.js").getDb;

beforeAll(async () => {
  // env.ts snapshots process.env at import time, so this must be set before
  // any module that reads it is loaded — hence the dynamic imports below.
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-bootstrap-")), "test.db");
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ buildGateHandlers } = await import("./bootstrap.js"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM assets").run();
  db.prepare("DELETE FROM article_translations").run();
  db.prepare("DELETE FROM articles").run();
  db.prepare("DELETE FROM keywords").run();
});

function seedArticle(id = "a1", keywordId = "k1") {
  const db = getDb();
  db.prepare("INSERT INTO keywords (id, query, status) VALUES (?, ?, 'generated')").run(keywordId, "a topic");
  db.prepare("INSERT INTO articles (id, keyword_id, title, slug, status) VALUES (?, ?, 'T', ?, 'review')")
    .run(id, keywordId, `slug-${id}`);
  // Every real article has both of these — they are what made the bug certain.
  db.prepare("INSERT INTO assets (id, article_id, type, url) VALUES (?, ?, 'thumbnail', 'u')").run(`as-${id}`, id);
  db.prepare("INSERT INTO article_translations (id, article_id, locale, title) VALUES (?, ?, 'ru', 'RU')").run(`t-${id}`, id);
}

describe("deleteArticle", () => {
  it("deletes an article that has assets and translations", async () => {
    seedArticle();
    const handlers = buildGateHandlers();

    await expect(handlers.onDelete("a1", 1)).resolves.toBeUndefined();

    const row = getDb().prepare("SELECT id FROM articles WHERE id = 'a1'").get();
    expect(row).toBeUndefined();
  });

  it("removes the children too, leaving no orphans", async () => {
    seedArticle();
    await buildGateHandlers().onDelete("a1", 1);

    const db = getDb();
    expect(db.prepare("SELECT COUNT(*) c FROM assets WHERE article_id = 'a1'").get()).toEqual({ c: 0 });
    expect(
      db.prepare("SELECT COUNT(*) c FROM article_translations WHERE article_id = 'a1'").get()
    ).toEqual({ c: 0 });
  });

  it("is a no-op for an unknown article", async () => {
    await expect(buildGateHandlers().onDelete("nope", 1)).resolves.toBeUndefined();
  });
});

describe("regenerateArticle", () => {
  it("deletes the article without a foreign-key error", async () => {
    seedArticle();
    await expect(buildGateHandlers().onRegenerate("a1", 1)).resolves.toBeUndefined();
    expect(getDb().prepare("SELECT id FROM articles WHERE id = 'a1'").get()).toBeUndefined();
  });

  it("resets the keyword to approved so the pipeline can regenerate it", async () => {
    seedArticle();
    await buildGateHandlers().onRegenerate("a1", 1);

    const kw = getDb().prepare("SELECT status FROM keywords WHERE id = 'k1'").get() as { status: string };
    expect(kw.status).toBe("approved");
  });
});
