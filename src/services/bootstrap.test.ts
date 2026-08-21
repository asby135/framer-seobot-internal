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
let publishIsOverdue: typeof import("./bootstrap.js").publishIsOverdue;
let articlesPublishedSince: typeof import("./bootstrap.js").articlesPublishedSince;
let articleUrl: typeof import("./bootstrap.js").articleUrl;

beforeAll(async () => {
  // env.ts snapshots process.env at import time, so this must be set before
  // any module that reads it is loaded — hence the dynamic imports below.
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-bootstrap-")), "test.db");
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ buildGateHandlers, publishIsOverdue, articlesPublishedSince, articleUrl } = await import(
    "./bootstrap.js"
  ));
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

describe("publishIsOverdue", () => {
  const WINDOW = 5 * 60 * 1000;
  const now = new Date("2026-08-21T16:40:00Z").getTime();

  it("is false while the publish is still inside its debounce window", () => {
    expect(publishIsOverdue("2026-08-21T16:38:00Z", now, WINDOW)).toBe(false);
  });

  it("is true once it has waited longer than the window", () => {
    // Re-arming restarts the countdown, so a service redeploying every couple
    // of minutes would never deploy — each boot pushes the deadline out again
    // while changes pile up in Framer as pending.
    expect(publishIsOverdue("2026-08-21T16:30:00Z", now, WINDOW)).toBe(true);
  });

  it("is true exactly at the boundary", () => {
    expect(publishIsOverdue("2026-08-21T16:35:00Z", now, WINDOW)).toBe(true);
  });

  it("re-arms rather than deploying on a corrupt timestamp", () => {
    expect(publishIsOverdue("not-a-date", now, WINDOW)).toBe(false);
  });
});

describe("articlesPublishedSince", () => {
  it("matches rows despite the ISO / SQLite timestamp mismatch", () => {
    // publishPendingSince is '2026-08-21T15:29:12.801Z'; published_at is
    // '2026-08-21 16:29:14'. Compared as strings, 'T' sorts AFTER ' ', so every
    // row from the same day reads as older than the cursor and the notification
    // would silently list nothing.
    const db = getDb();
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, content, status, published_at)
       VALUES ('a1', NULL, 'Shipped Today', 'shipped-today', '<p>x</p>', 'published', '2026-08-21 16:29:14')`
    ).run();

    const found = articlesPublishedSince("2026-08-21T15:29:12.801Z");
    expect(found.map((a) => a.slug)).toContain("shipped-today");
  });

  it("excludes articles published before the deploy was armed", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, content, status, published_at)
       VALUES ('a2', NULL, 'Yesterday', 'yesterday', '<p>x</p>', 'published', '2026-08-20 09:00:00')`
    ).run();

    const found = articlesPublishedSince("2026-08-21T15:29:12.801Z");
    expect(found.map((a) => a.slug)).not.toContain("yesterday");
  });
});

describe("articleUrl", () => {
  const SITE = "https://crmchat.ai/blog";

  it("falls back to the bare slug when SITE_URL is unset", () => {
    expect(articleUrl("some-slug", "")).toBe("/some-slug");
  });

  it("joins the base and the slug with exactly one separator", () => {
    expect(articleUrl("telegram-vs-signal", SITE)).toBe(
      "https://crmchat.ai/blog/telegram-vs-signal"
    );
  });

  it("does NOT double the path prefix", () => {
    // SITE_URL carries /blog and the slug never does — they are built in
    // different places (this helper vs the generator's hardcoded
    // <a href="/blog/slug"> body links) and never concatenated with each other.
    expect(articleUrl("telegram-vs-signal", SITE)).not.toContain("/blog/blog");
  });

  it("tolerates a trailing slash on the base", () => {
    expect(articleUrl("x", "https://crmchat.ai/blog/")).toBe("https://crmchat.ai/blog/x");
    expect(articleUrl("x", "https://crmchat.ai/blog///")).toBe("https://crmchat.ai/blog/x");
  });

  it("keeps a slug that legitimately starts with the word blog", () => {
    // A title beginning "Blog…" yields such a slug. /blog/blog-post-ideas is
    // the correct URL, not a duplicated prefix.
    expect(articleUrl("blog-post-ideas", SITE)).toBe("https://crmchat.ai/blog/blog-post-ideas");
  });
});
