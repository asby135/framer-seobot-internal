import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { enqueueGeneration, getQueueStatus } from "../services/queue.js";
import { translateArticle } from "../services/translator.js";
import { logger } from "../lib/logger.js";

const articles = new Hono();

// List articles by status
articles.get("/", (c) => {
  const db = getDb();
  const status = c.req.query("status");

  let rows;
  if (status) {
    rows = db
      .prepare(
        `SELECT id, keyword_id, title, slug, category, summary, status, flags,
                created_at, updated_at, published_at
         FROM articles WHERE status = ? ORDER BY updated_at DESC`
      )
      .all(status);
  } else {
    rows = db
      .prepare(
        `SELECT id, keyword_id, title, slug, category, summary, status, flags,
                created_at, updated_at, published_at
         FROM articles ORDER BY updated_at DESC`
      )
      .all();
  }

  return c.json({ articles: rows });
});

// Get full article with assets
articles.get("/:id", (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const article = db
    .prepare("SELECT * FROM articles WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!article) {
    return c.json({ error: "Article not found" }, 404);
  }

  const assets = db
    .prepare("SELECT * FROM assets WHERE article_id = ?")
    .all(id);

  return c.json({ ...article, assets });
});

// Mark article as published
articles.post("/:id/publish", (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const result = db
    .prepare(
      `UPDATE articles
       SET status = 'published', published_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status IN ('draft', 'review')`
    )
    .run(id);

  if (result.changes === 0) {
    return c.json(
      { error: "Article not found or not in draft/review status" },
      404
    );
  }

  return c.json({ success: true });
});

// Delete an article
articles.post("/:id/delete", (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const article = db.prepare("SELECT keyword_id FROM articles WHERE id = ?").get(id) as { keyword_id: string } | undefined;
  if (!article) {
    return c.json({ error: "Article not found" }, 404);
  }

  // Delete related data first (FK constraints)
  db.prepare("DELETE FROM article_translations WHERE article_id = ?").run(id);
  db.prepare("DELETE FROM assets WHERE article_id = ?").run(id);
  db.prepare("DELETE FROM articles WHERE id = ?").run(id);

  // Reset keyword status so it can be re-generated
  db.prepare("UPDATE keywords SET status = 'approved' WHERE id = ?").run(article.keyword_id);

  logger.info({ articleId: id }, "Article deleted");
  return c.json({ success: true });
});

// Regenerate an article with optional editing instructions
articles.post("/:id/regenerate", async (c) => {
  const db = getDb();
  const { id } = c.req.param();
  const body = await c.req.json<{ instructions?: string }>().catch(() => ({ instructions: undefined }));

  const article = db.prepare("SELECT keyword_id FROM articles WHERE id = ?").get(id) as { keyword_id: string } | undefined;
  if (!article) {
    return c.json({ error: "Article not found" }, 404);
  }

  const keyword = db.prepare("SELECT id, query FROM keywords WHERE id = ?").get(article.keyword_id) as { id: string; query: string } | undefined;
  if (!keyword) {
    return c.json({ error: "Associated keyword not found" }, 404);
  }

  const queueStatus = getQueueStatus();
  if (queueStatus.active > 0 || queueStatus.pending > 0) {
    return c.json({ error: "Generation already in progress" }, 409);
  }

  // Delete old article, translations, and assets
  db.prepare("DELETE FROM article_translations WHERE article_id = ?").run(id);
  db.prepare("DELETE FROM assets WHERE article_id = ?").run(id);
  db.prepare("DELETE FROM articles WHERE id = ?").run(id);

  // Reset keyword to approved so generator picks it up
  db.prepare("UPDATE keywords SET status = 'approved' WHERE id = ?").run(keyword.id);

  // If instructions provided, store them temporarily on the keyword
  if (body.instructions?.trim()) {
    db.prepare("UPDATE keywords SET search_volume = NULL WHERE id = ?").run(keyword.id);
    // Store instructions in a temp field — we'll pass it via the query
    const modifiedQuery = `${keyword.query} [EDITING INSTRUCTIONS: ${body.instructions.trim()}]`;
    enqueueGeneration({ keywordId: keyword.id, query: modifiedQuery });
  } else {
    enqueueGeneration({ keywordId: keyword.id, query: keyword.query });
  }

  logger.info({ articleId: id, keywordId: keyword.id, hasInstructions: !!body.instructions }, "Article regeneration enqueued");
  return c.json({ status: "queued", keyword_id: keyword.id, query: keyword.query });
});

// Bulk import articles (for migrating from external CMS)
articles.post("/import", async (c) => {
  const db = getDb();
  const body = await c.req.json<{
    articles: Array<{
      title: string;
      slug: string;
      summary: string;
      category: string;
      content: string;
      image_url?: string;
      date?: string;
    }>;
  }>();

  if (!body.articles?.length) {
    return c.json({ error: "No articles provided" }, 400);
  }

  const insertArticle = db.prepare(
    `INSERT OR IGNORE INTO articles (id, keyword_id, title, slug, category, summary, content, status, flags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'published', '{}', ?, ?)`
  );

  const insertAsset = db.prepare(
    `INSERT INTO assets (id, article_id, type, url, alt_text)
     VALUES (?, ?, 'thumbnail', ?, ?)`
  );

  let imported = 0;
  const importAll = db.transaction(() => {
    for (const a of body.articles) {
      const articleId = nanoid();
      const keywordId = nanoid();

      // Create a placeholder keyword
      db.prepare(
        `INSERT OR IGNORE INTO keywords (id, query, source, status, opportunity_score)
         VALUES (?, ?, 'import', 'generated', 0)`
      ).run(keywordId, a.title);

      const dateStr = a.date ? new Date(a.date).toISOString().replace("T", " ").slice(0, 19) : new Date().toISOString().replace("T", " ").slice(0, 19);
      insertArticle.run(articleId, keywordId, a.title, a.slug, a.category || "guides", a.summary || "", a.content, dateStr, dateStr);

      if (a.image_url) {
        insertAsset.run(nanoid(), articleId, a.image_url, a.title);
      }

      imported++;
    }
  });

  importAll();
  logger.info({ imported }, "Articles imported");
  return c.json({ status: "complete", imported });
});

// Translate an article into all configured locales
articles.post("/:id/translate", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));

  try {
    const result = await translateArticle(id, body.force ?? false);
    return c.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

// Translate all published articles
articles.post("/translate-all", async (c) => {
  const db = getDb();
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));

  const publishedArticles = db
    .prepare("SELECT id, title FROM articles WHERE status = 'published'")
    .all() as Array<{ id: string; title: string }>;

  const results: Array<{ id: string; title: string; translated: string[]; skipped: string[] }> = [];

  for (const article of publishedArticles) {
    try {
      const result = await translateArticle(article.id, body.force ?? false);
      results.push({ id: article.id, title: article.title, ...result });
    } catch (e) {
      logger.error({ articleId: article.id, error: e instanceof Error ? e.message : "unknown" }, "Translation failed");
    }
  }

  return c.json({ status: "complete", articles: results });
});

export { articles };
