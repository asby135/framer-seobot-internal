import { Hono } from "hono";
import { getDb } from "../db/index.js";

const sync = new Hono();

interface Translation {
  locale: string;
  title: string;
  slug: string;
  summary: string;
  content: string;
}

// Get all published articles formatted for Framer CMS (with translations)
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

  // Fetch all translations in one query
  const allTranslations = db
    .prepare(
      `SELECT t.article_id, t.locale, t.title, t.slug, t.summary, t.content
       FROM article_translations t
       JOIN articles a ON a.id = t.article_id
       WHERE a.status = 'published'`
    )
    .all() as Array<Translation & { article_id: string }>;

  // Group translations by article
  const translationsByArticle = new Map<string, Translation[]>();
  for (const t of allTranslations) {
    const existing = translationsByArticle.get(t.article_id) || [];
    existing.push({ locale: t.locale, title: t.title, slug: t.slug, summary: t.summary, content: t.content });
    translationsByArticle.set(t.article_id, existing);
  }

  // Format for Framer managed collection
  const items = articles.map((a) => {
    const translations = translationsByArticle.get(a.id) || [];

    // Build valueByLocale maps for translatable fields
    const titleByLocale: Record<string, { action: string; value: string }> = {};
    const slugByLocale: Record<string, { action: string; value: string }> = {};
    const summaryByLocale: Record<string, { action: string; value: string }> = {};
    const contentByLocale: Record<string, { action: string; value: string }> = {};

    for (const t of translations) {
      titleByLocale[t.locale] = { action: "set", value: t.title };
      if (t.slug) slugByLocale[t.locale] = { action: "set", value: t.slug };
      summaryByLocale[t.locale] = { action: "set", value: t.summary };
      contentByLocale[t.locale] = { action: "set", value: t.content };
    }

    return {
      id: a.id,
      slug: a.slug,
      slugByLocale,
      fieldData: {
        title: { type: "string", value: a.title, valueByLocale: titleByLocale },
        slug: { type: "string", value: a.slug },
        category: { type: "string", value: a.category || "" },
        summary: { type: "string", value: a.summary || "", valueByLocale: summaryByLocale },
        content: { type: "formattedText", value: a.content || "", valueByLocale: contentByLocale },
        created: { type: "date", value: a.created_at },
        updated: { type: "date", value: a.updated_at },
        image: a.image_url ? { type: "image", value: a.image_url } : { type: "image", value: "" },
        tool: { type: "string", value: "crmchat-seo-engine" },
      },
    };
  });

  return c.json({ items, locales: ["ru", "ua", "fr"] });
});

export { sync };
