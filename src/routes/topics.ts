import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { loadTitleCorpus } from "../services/seeder.js";
import { createTitleIndex } from "../services/similarity.js";
import { ASSIGNABLE_SOURCES, SERPSTAT_SOURCE } from "../lib/topic-source.js";

const topics = new Hono();

// List keyword opportunities (scored, ranked) with pagination
topics.get("/", (c) => {
  const db = getDb();
  const status = c.req.query("status") || "pending";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const offset = (page - 1) * limit;
  const excludeWithArticles = c.req.query("exclude_with_articles") === "1";

  const whereClause = excludeWithArticles
    ? // The Generate tab's view: approved, no article yet, and not already
      // queued — listing queued topics invited a second generation.
      "WHERE k.status = ? AND k.generation_job IS NULL AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.keyword_id = k.id)"
    : "WHERE k.status = ?";

  const rows = db
    .prepare(
      `SELECT k.id, k.query, k.source, k.niche, k.impressions, k.clicks, k.ctr, k.position,
              k.search_volume, k.opportunity_score, k.status, k.created_at
       FROM keywords k
       ${whereClause}
       ORDER BY
         CASE
           WHEN k.source = 'era-gap' THEN 0
           WHEN k.source IN ('custom', 'seeded', 'serpstat') THEN 1
           ELSE 2
         END,
         CASE WHEN k.source IN ('era-gap', 'custom', 'seeded', 'serpstat') THEN k.created_at END DESC,
         k.opportunity_score DESC
       LIMIT ? OFFSET ?`
    )
    .all(status, limit, offset);

  const total = (db
    .prepare(`SELECT COUNT(*) as count FROM keywords k ${whereClause}`)
    .get(status) as { count: number }).count;

  return c.json({ topics: rows, total, page, pages: Math.ceil(total / limit) });
});

// Approve a topic for generation
topics.post("/:id/approve", (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const result = db
    .prepare(
      "UPDATE keywords SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
    .run(id);

  if (result.changes === 0) {
    return c.json({ error: "Topic not found or not in pending status" }, 404);
  }

  return c.json({ success: true });
});

// Reject a topic. Accepts pending OR approved — the Generate tab calls this
// to send an already-approved topic back to rejected (the user changed their
// mind). Generated topics are excluded (they have an article — delete the
// article instead).
topics.post("/:id/reject", (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const result = db
    .prepare(
      "UPDATE keywords SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'approved')"
    )
    .run(id);

  if (result.changes === 0) {
    return c.json({ error: "Topic not found or not rejectable (already generated or rejected)" }, 404);
  }

  return c.json({ success: true });
});

// Submit a custom topic
topics.post("/custom", async (c) => {
  const db = getDb();
  const body = await c.req.json<{ query: string; force?: boolean; source?: string }>();

  if (!body.query?.trim()) {
    return c.json({ error: "Query is required" }, 400);
  }
  // A custom topic may say it came from Serpstat research, so gate 2 tags it.
  if (body.source !== undefined && body.source !== "custom" && body.source !== SERPSTAT_SOURCE) {
    return c.json({ error: `source must be custom or ${SERPSTAT_SOURCE}` }, 400);
  }
  const source = body.source ?? "custom";

  // The same checks seeded topics get. Custom topics had none, so a repeat of
  // a published article — or the same topic added twice, since it vanished
  // from the screen it was added on — went straight to generation. `force`
  // is the operator overriding a match they have seen.
  const query = body.query.trim();

  // An existing topic with the exact text decides what happens: say its state;
  // and with `force`, act on THAT row rather than adding a second one —
  // two rows for one topic risk two articles.
  const existing = db
    .prepare("SELECT id, query, status FROM keywords WHERE lower(query) = lower(?) ORDER BY created_at LIMIT 1")
    .get(query) as { id: string; query: string; status: string } | undefined;
  if (existing) {
    if (body.force && (existing.status === "pending" || existing.status === "rejected")) {
      db.prepare("UPDATE keywords SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(existing.id);
      return c.json({ id: existing.id, status: "approved" }, 201);
    }
    return c.json(
      {
        error: `Already exists as a ${existing.status} topic: “${existing.query}”${
          existing.status === "pending" || existing.status === "rejected" ? " — Add anyway approves it" : ""
        }`,
        matched: existing.query,
        matchedStatus: existing.status,
      },
      409
    );
  }

  // The same checks seeded topics get. Custom topics had none, so a repeat of
  // a published article — or the same topic added twice, since it vanished
  // from the screen it was added on — went straight to generation. `force`
  // is the operator overriding a near match they have seen.
  if (!body.force) {
    const corpus = loadTitleCorpus();
    const exact = corpus.find((t) => t.trim().toLowerCase() === query.toLowerCase());
    const matched = exact ?? createTitleIndex(corpus).match(query);
    if (matched) {
      return c.json(
        { error: exact ? `Already exists: “${matched}”` : `Too close to an existing topic or article: “${matched}”`, matched },
        409
      );
    }
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO keywords (id, query, source, status, opportunity_score)
     VALUES (?, ?, ?, 'approved', 0)`
  ).run(id, body.query.trim(), source);

  return c.json({ id, status: "approved" }, 201);
});

// Re-tag the source of topics that are not written yet, matched by exact text.
// For topics added before their source could be named (the first Serpstat
// batch went in as plain 'seeded' and 'custom'). Generated and rejected topics
// are left alone: their articles and history should keep what they were.
topics.post("/source", async (c) => {
  const body = await c.req
    .json<{ source?: string; queries?: string[] }>()
    .catch(() => ({ source: undefined, queries: undefined }));

  if (!body.source || !ASSIGNABLE_SOURCES.has(body.source)) {
    return c.json({ error: `source must be one of: ${[...ASSIGNABLE_SOURCES].join(", ")}` }, 400);
  }
  if (!Array.isArray(body.queries) || body.queries.length === 0) {
    return c.json({ error: "queries must be a non-empty array of topic texts" }, 400);
  }

  const db = getDb();
  const stmt = db.prepare(
    `UPDATE keywords SET source = ?, updated_at = datetime('now')
      WHERE lower(query) = lower(?) AND status IN ('pending', 'approved')`
  );
  const unmatched: string[] = [];
  let updated = 0;
  db.transaction((queries: string[]) => {
    for (const q of queries.slice(0, 200)) {
      const changes = stmt.run(body.source, (q ?? "").trim()).changes;
      if (changes === 0) unmatched.push(q);
      updated += changes;
    }
  })(body.queries);

  return c.json({ updated, unmatched });
});

export { topics };
