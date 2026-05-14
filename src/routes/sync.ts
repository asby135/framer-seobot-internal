import { Hono } from "hono";
import { getDb } from "../db/index.js";

const sync = new Hono();

interface Translation {
  locale: string;
  title: string;
  slug: string | null;
  summary: string;
  content: string;
  schema_jsonld: string | null;
}

// Get all published articles formatted for Framer CMS (with translations)
sync.get("/collection", (c) => {
  const db = getDb();

  const articles = db
    .prepare(
      `SELECT a.id, a.title, a.slug, a.category, a.summary, a.content, a.schema_jsonld,
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
    schema_jsonld: string | null;
    created_at: string;
    updated_at: string;
    image_url: string | null;
  }>;

  // Fetch all translations in one query
  const allTranslations = db
    .prepare(
      `SELECT t.article_id, t.locale, t.title, t.slug, t.summary, t.content, t.schema_jsonld
       FROM article_translations t
       JOIN articles a ON a.id = t.article_id
       WHERE a.status = 'published'`
    )
    .all() as Array<Translation & { article_id: string }>;

  // Group translations by article
  const translationsByArticle = new Map<string, Translation[]>();
  for (const t of allTranslations) {
    const existing = translationsByArticle.get(t.article_id) || [];
    existing.push({
      locale: t.locale,
      title: t.title,
      slug: t.slug,
      summary: t.summary,
      content: t.content,
      schema_jsonld: t.schema_jsonld,
    });
    translationsByArticle.set(t.article_id, existing);
  }

  // Format for Framer managed collection
  const items = articles.map((a) => {
    const translations = translationsByArticle.get(a.id) || [];

    // Build valueByLocale maps for translatable fields
    const titleByLocale: Record<string, { action: string; value: string }> = {};
    const summaryByLocale: Record<string, { action: string; value: string }> = {};
    const contentByLocale: Record<string, { action: string; value: string }> = {};
    const schemaJsonldByLocale: Record<string, { action: string; value: string }> = {};

    for (const t of translations) {
      titleByLocale[t.locale] = { action: "set", value: t.title };
      summaryByLocale[t.locale] = { action: "set", value: t.summary };
      contentByLocale[t.locale] = { action: "set", value: t.content };
      // Only emit schema for this locale if it's non-empty; an empty string
      // means the translator validated and dropped the localized schema.
      // Framer's template will render no <script> tag for that locale.
      if (t.schema_jsonld) {
        schemaJsonldByLocale[t.locale] = { action: "set", value: t.schema_jsonld };
      }
    }

    return {
      id: a.id,
      slug: a.slug,
      fieldData: {
        title: { type: "string", value: a.title, valueByLocale: titleByLocale },
        category: { type: "string", value: a.category || "" },
        summary: { type: "string", value: a.summary || "", valueByLocale: summaryByLocale },
        content: { type: "formattedText", value: a.content || "", valueByLocale: contentByLocale },
        schema_jsonld: {
          type: "string",
          value: a.schema_jsonld || "",
          valueByLocale: schemaJsonldByLocale,
        },
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
