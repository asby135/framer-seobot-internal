import { Hono } from "hono";
import { getDb } from "../db/index.js";

const sync = new Hono();

// Get all published articles formatted for Framer CMS
sync.get("/collection", (c) => {
  const db = getDb();

  const articles = db
    .prepare(
      `SELECT a.id, a.title, a.slug, a.category, a.summary, a.content,
              a.created_at, a.updated_at,
              (SELECT url FROM assets WHERE article_id = a.id AND type = 'thumbnail' LIMIT 1) as image_url
       FROM articles a
       WHERE a.status = 'published'
       ORDER BY a.published_at DESC`
    )
    .all() as Array<{
    id: string;
    title: string;
    slug: string;
    category: string;
    summary: string;
    content: string;
    created_at: string;
    updated_at: string;
    image_url: string | null;
  }>;

  // Format for Framer managed collection
  const items = articles.map((a) => ({
    id: a.id,
    fieldData: {
      title: a.title,
      slug: a.slug,
      category: a.category || "",
      summary: a.summary || "",
      content: a.content || "",
      created: a.created_at,
      updated: a.updated_at,
      image: a.image_url || "",
      tool: "crmchat-seo-engine",
    },
  }));

  return c.json({ items });
});

export { sync };
