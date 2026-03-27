import { Hono } from "hono";
import { getDb } from "../db/index.js";

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

export { articles };
