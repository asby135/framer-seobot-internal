import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { sanitizeJsonLd } from "../lib/jsonld.js";
import { syncToFramer, previewSyncToFramer } from "../services/framer-sync.js";
import { logger } from "../lib/logger.js";

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
      // Defense-in-depth: re-sanitize at the egress point. Stored values
      // should already be safe (generator + translator sanitize before
      // writing), but Framer renders this verbatim via unsafeRaw inside a
      // <script> tag — any unsafe row (legacy, manual edit) is dropped here.
      // Only emit a per-locale entry when there's a valid, safe schema.
      if (t.schema_jsonld) {
        const safe = sanitizeJsonLd(t.schema_jsonld);
        if (safe) {
          schemaJsonldByLocale[t.locale] = { action: "set", value: safe };
        }
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
          value: sanitizeJsonLd(a.schema_jsonld || "") || "",
          valueByLocale: schemaJsonldByLocale,
        },
        created: { type: "date", value: a.created_at },
        updated: { type: "date", value: a.updated_at },
        image: a.image_url ? { type: "image", value: a.image_url } : { type: "image", value: "" },
        tool: { type: "string", value: "crmchat-seo-engine" },
      },
    };
  });

  return c.json({ items, locales: ["ru"] });
});

/**
 * Dry-run the Framer sync. Connects and reports, writes nothing.
 *
 * The guard verdict is the point. syncToFramer holds real destructive power
 * over a live corpus, and the honest way to trust its arithmetic is to read it
 * against real data before granting a write.
 */
sync.get("/framer/preview", async (c) => {
  try {
    const preview = await previewSyncToFramer();
    logger.info(
      { stale: preview.staleCount, proceed: preview.wouldProceed },
      "Sync preview requested"
    );
    return c.json(preview);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message }, "Sync preview failed");
    return c.json({ error: message }, 500);
  }
});

/**
 * Run the Framer sync by hand.
 *
 * Both a deliberate first-run path — so the sync's first contact with the live
 * collection is a human watching it, not a scheduled bot — and the standing
 * recovery path when something goes wrong unattended.
 *
 * Does NOT publish the site; that stays a separate, explicit act.
 */
sync.post("/framer", async (c) => {
  try {
    // ?force=1 rewrites every item instead of only what changed. For when
    // Framer's copy has drifted from ours — an item edited or deleted in the
    // Framer UI, which no fingerprint can detect.
    const force = c.req.query("force") === "1";
    const result = await syncToFramer(force);
    return c.json({ success: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message }, "Manual Framer sync failed");
    // A guard tripping is the expected failure here, and its message says why.
    return c.json({ error: message }, 500);
  }
});

export { sync };
