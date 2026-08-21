import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { faqVerdict } from "../lib/jsonld.js";
import { buildGateHandlers } from "../services/bootstrap.js";
import {
  enqueueGeneration,
  enqueueTranslation,
  getQueueStatus,
  getTranslationQueueStatus,
} from "../services/queue.js";
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
      .all(status) as Array<Record<string, unknown> & { id: string }>;
  } else {
    rows = db
      .prepare(
        `SELECT id, keyword_id, title, slug, category, summary, status, flags,
                created_at, updated_at, published_at
         FROM articles ORDER BY updated_at DESC`
      )
      .all() as Array<Record<string, unknown> & { id: string }>;
  }

  // Attach translatedLocales per article — one IN-query covers the whole list
  // so we don't issue N queries for N articles.
  const ids = rows.map((r) => r.id);
  const localesByArticle = new Map<string, string[]>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const localeRows = db
      .prepare(
        `SELECT article_id, locale FROM article_translations WHERE article_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ article_id: string; locale: string }>;
    for (const r of localeRows) {
      const existing = localesByArticle.get(r.article_id) ?? [];
      existing.push(r.locale);
      localesByArticle.set(r.article_id, existing);
    }
  }
  const enriched = rows.map((r) => ({
    ...r,
    translatedLocales: localesByArticle.get(r.id) ?? [],
  }));

  return c.json({ articles: enriched });
});

// Translation queue status.
//
// MUST stay above `GET /:id`: Hono matches routes in registration order, so a
// literal path registered after a parameterised one is shadowed — this
// endpoint previously returned {"error":"Article not found"} for every call,
// silently breaking the plugin's translation polling.
articles.get("/translate-status", (c) => {
  return c.json({ queue: getTranslationQueueStatus() });
});

// Get full article with assets
/**
 * Schema + FAQ coverage across published articles.
 *
 * Registered BEFORE /:id — Hono matches in registration order, so a literal
 * route declared after a parameterized one is never reached.
 *
 * A generation whose schema retry fails still publishes: an article without
 * rich data beats no article. That makes missing schema silent by design, so
 * it has to be audited rather than waited for.
 */
articles.get("/schema-audit", (c) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, slug, schema_jsonld FROM articles
       WHERE status = 'published' ORDER BY published_at DESC`
    )
    .all() as Array<{ id: string; title: string; slug: string; schema_jsonld: string | null }>;

  const ru = new Map(
    (
      db
        .prepare(
          `SELECT t.article_id, t.schema_jsonld FROM article_translations t
           JOIN articles a ON a.id = t.article_id
           WHERE a.status = 'published' AND t.locale = 'ru'`
        )
        .all() as Array<{ article_id: string; schema_jsonld: string | null }>
    ).map((r) => [r.article_id, r.schema_jsonld])
  );

  const buckets: Record<string, Array<{ id: string; title: string; slug: string }>> = {
    missing: [],
    invalid: [],
    "not-faq": [],
    thin: [],
    "ru-missing": [],
  };

  let ok = 0;
  for (const r of rows) {
    const verdict = faqVerdict(r.schema_jsonld);
    if (verdict === "ok") ok++;
    else buckets[verdict].push({ id: r.id, title: r.title, slug: r.slug });

    // RU pages carry their own schema; an untranslated one is not a gap, an
    // empty one on a translated article is.
    if (ru.has(r.id) && faqVerdict(ru.get(r.id)) !== "ok") {
      buckets["ru-missing"].push({ id: r.id, title: r.title, slug: r.slug });
    }
  }

  return c.json({
    published: rows.length,
    ok,
    counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    // Capped: this is a worklist to act on, not a data dump.
    articles: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.slice(0, 50)])),
  });
});

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

  const translatedLocales = (
    db.prepare("SELECT locale FROM article_translations WHERE article_id = ?").all(id) as { locale: string }[]
  ).map((r) => r.locale);

  return c.json({ ...article, assets, translatedLocales });
});

// Mark article as published
articles.post("/:id/publish", async (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const before = db.prepare("SELECT status FROM articles WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  if (!before || !["draft", "review"].includes(before.status)) {
    return c.json({ error: "Article not found or not in draft/review status" }, 404);
  }

  // Publishing means REACHING THE SITE, not flipping a column.
  //
  // This route used to only mark the row published. Articles then read as
  // "Published" in the plugin while Framer had never received them, and the
  // divergence was invisible from either side. Delegating to the Telegram
  // gate's handler — mark published, sync to Framer, roll back if the sync
  // fails — means both entry points publish the same way by construction
  // rather than by two implementations agreeing.
  await buildGateHandlers().onPublish(id, 0);

  // onPublish reverts to 'review' when the sync fails, so the row is the
  // verdict. It reports failure over Telegram; the HTTP caller needs it too.
  const after = db.prepare("SELECT status FROM articles WHERE id = ?").get(id) as {
    status: string;
  };
  if (after.status !== "published") {
    return c.json(
      { error: "Framer sync failed — publish reverted, retry once the sync issue clears" },
      502
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

// Update article fields (title, summary, content) without regenerating
articles.post("/:id/update", async (c) => {
  const db = getDb();
  const { id } = c.req.param();
  const body = await c.req.json<{ title?: string; summary?: string; content?: string }>().catch(() => ({} as { title?: string; summary?: string; content?: string }));

  const article = db.prepare("SELECT id, status FROM articles WHERE id = ?").get(id) as { id: string; status: string } | undefined;
  if (!article) {
    return c.json({ error: "Article not found" }, 404);
  }

  if (article.status === "generation_failed") {
    return c.json({ error: "Cannot edit a failed article" }, 400);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.title !== undefined && body.title.trim()) {
    updates.push("title = ?");
    values.push(body.title.trim());
  }
  if (body.summary !== undefined) {
    updates.push("summary = ?");
    values.push(body.summary.trim());
  }
  if (body.content !== undefined) {
    updates.push("content = ?");
    values.push(body.content);
  }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE articles SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
  logger.info({ articleId: id, fields: updates.length - 1 }, "Article updated manually");
  return c.json(updated);
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

// Translate an article into all configured locales.
// Enqueues onto the translation queue (concurrency=1) so stacking multiple
// translations stays bounded on Anthropic in-flight calls.
articles.post("/:id/translate", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));

  const db = getDb();
  const article = db.prepare("SELECT id FROM articles WHERE id = ?").get(id);
  if (!article) {
    return c.json({ error: "Article not found" }, 404);
  }

  enqueueTranslation({ articleId: id, force: body.force ?? false });
  logger.info({ articleId: id }, "Translation enqueued");

  return c.json(
    {
      status: "queued",
      article_id: id,
      queue: getTranslationQueueStatus(),
    },
    202
  );
});

// Bulk-enqueue multiple article translations. Atomic single-request enqueue.
articles.post("/translate-batch", async (c) => {
  const body = await c.req
    .json<{ article_ids?: string[]; force?: boolean }>()
    .catch(() => ({ article_ids: undefined, force: false }));

  if (!body.article_ids || !Array.isArray(body.article_ids) || body.article_ids.length === 0) {
    return c.json({ error: "article_ids array required" }, 400);
  }

  // Dedup + cap to 20
  const uniqueIds = [...new Set(body.article_ids)].slice(0, 20);

  const db = getDb();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const found = db
    .prepare(`SELECT id, title FROM articles WHERE id IN (${placeholders})`)
    .all(...uniqueIds) as Array<{ id: string; title: string }>;

  if (found.length === 0) {
    return c.json({ error: "No matching articles found" }, 404);
  }

  const force = body.force ?? false;
  for (const a of found) {
    enqueueTranslation({ articleId: a.id, force });
  }

  logger.info({ enqueued: found.length, force }, "Batch translation enqueued");

  return c.json(
    {
      status: "queued",
      enqueued: found.map((a) => ({ article_id: a.id, title: a.title })),
      queue: getTranslationQueueStatus(),
    },
    202
  );
});

// Translation queue status — parallel to /api/generate/status
// Translate all published articles (runs in background)
articles.post("/translate-all", async (c) => {
  const db = getDb();
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));

  const publishedArticles = db
    .prepare("SELECT id, title FROM articles WHERE status = 'published'")
    .all() as Array<{ id: string; title: string }>;

  // Fire and forget — translations run in background
  (async () => {
    for (const article of publishedArticles) {
      try {
        const result = await translateArticle(article.id, body.force ?? false);
        logger.info({ articleId: article.id, ...result }, "Article translation completed");
      } catch (e) {
        logger.error({ articleId: article.id, error: e instanceof Error ? e.message : "unknown" }, "Translation failed");
      }
    }
    logger.info({ count: publishedArticles.length }, "Translate-all completed");
  })();

  return c.json({ status: "translating", count: publishedArticles.length, message: "Translations started in background" });
});

export { articles };
