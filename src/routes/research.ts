import { Hono } from "hono";
import { seedTopics, insertSeededTopics } from "../services/seeder.js";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

const research = new Hono();

// NOTE: POST / used to pull keywords from Era (OhMyGEO). Era is retired — its
// queries duplicated already-published articles and its topics are excluded
// from selection (see selection.ts USABLE_SOURCES). The route is gone rather
// than merely unwired so a stale plugin build cannot re-import them: it now
// 404s instead of refilling the queue.

// Seed pending topics for a target audience, grounded in the knowledge base.
// Generates topic IDEAS from an audience persona + KB (no external source),
// inserts them as pending with source='seeded' for normal review/generation.
research.post("/seed", async (c) => {
  const body = await c.req
    .json<{ audience?: string; count?: number; topics?: string[] }>()
    .catch(() => ({ audience: undefined, count: undefined, topics: undefined }));

  // Direct-import path: a known list of topic phrases (e.g. externally adapted
  // from another blog). Inserts as-is, skipping Claude generation.
  if (Array.isArray(body.topics) && body.topics.length > 0) {
    try {
      const result = insertSeededTopics(body.topics.slice(0, 100));
      logger.info(
        { provided: body.topics.length, seeded: result.seeded.length, revived: result.revived, skipped: result.skipped },
        "Direct topic import complete"
      );
      return c.json({
        status: "complete",
        source: "import",
        seeded: result.seeded.length,
        revived: result.revived,
        skipped: result.skipped,
        topics: result.seeded,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      logger.error({ error: message }, "Topic import failed");
      return c.json({ error: message }, 500);
    }
  }

  // Generation path: derive topics from an audience persona + KB.
  const audience = body.audience?.trim();
  if (!audience) {
    return c.json(
      { error: 'provide either { topics: string[] } to import, or { audience: "..." } to generate' },
      400
    );
  }

  try {
    const result = await seedTopics(audience, body.count ?? 10);
    return c.json({
      status: "complete",
      audience: result.audience,
      seeded: result.seeded.length,
      skipped: result.skipped,
      topics: result.seeded,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message, audience }, "Topic seeding failed");
    return c.json({ error: message }, 500);
  }
});

// Clear stale keywords by source — e.g. legacy GSC rows after the Era pivot.
//   ?source=gsc                   → deletes pending GSC keywords (default)
//   ?source=gsc&status=approved   → deletes approved-but-not-generated GSC keywords
// Only 'pending' and 'approved' are allowed. 'generated' rows are referenced by
// articles.keyword_id; 'rejected' rows are already inert. 'approved' rows have
// no article yet (status flips to 'generated' when an article is created), so
// deleting them is safe.
research.delete("/keywords", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  if (!source) {
    return c.json({ error: "source query param required, e.g. ?source=gsc" }, 400);
  }
  const status = c.req.query("status") || "pending";
  if (status !== "pending" && status !== "approved") {
    return c.json(
      { error: "status must be 'pending' or 'approved' (default 'pending')" },
      400
    );
  }
  const result = db
    .prepare("DELETE FROM keywords WHERE source = ? AND status = ?")
    .run(source, status);
  logger.info(
    { source, status, deleted: result.changes },
    "Cleared keywords by source + status"
  );
  return c.json({ status: "complete", source, statusFilter: status, deleted: result.changes });
});

export { research };
