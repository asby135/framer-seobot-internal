import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { enqueueGeneration, getQueueStatus } from "../services/queue.js";
import { logger } from "../lib/logger.js";

const generate = new Hono();

// Simple in-memory rate limiter
const rateLimiter = {
  timestamps: [] as number[],
  maxPerHour: 10,

  check(): boolean {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    this.timestamps = this.timestamps.filter((t) => t > oneHourAgo);
    return this.timestamps.length < this.maxPerHour;
  },

  record(): void {
    this.timestamps.push(Date.now());
  },

  remaining(): number {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    this.timestamps = this.timestamps.filter((t) => t > oneHourAgo);
    return Math.max(0, this.maxPerHour - this.timestamps.length);
  },
};

// Trigger article generation for approved topics
generate.post("/", async (c) => {
  if (!rateLimiter.check()) {
    return c.json(
      {
        error: "Rate limit exceeded. Max 10 generations per hour.",
        remaining: 0,
      },
      429
    );
  }

  const db = getDb();
  const body = await c.req.json<{ keyword_id?: string }>().catch(() => ({ keyword_id: undefined }));

  let approved: { id: string; query: string } | undefined;

  if (body.keyword_id) {
    // Generate a specific topic
    approved = db
      .prepare(
        `SELECT k.id, k.query FROM keywords k
         WHERE k.id = ? AND k.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.keyword_id = k.id)`
      )
      .get(body.keyword_id) as { id: string; query: string } | undefined;
  } else {
    // Pick the highest-scoring approved topic
    approved = db
      .prepare(
        `SELECT k.id, k.query FROM keywords k
         WHERE k.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.keyword_id = k.id)
         ORDER BY k.opportunity_score DESC
         LIMIT 1`
      )
      .get() as { id: string; query: string } | undefined;
  }

  if (!approved) {
    return c.json({ error: "No approved topics waiting for generation" }, 404);
  }

  // PQueue serializes everything (concurrency=1), so it's safe to stack more
  // jobs behind whatever is already running — they'll just wait their turn.

  rateLimiter.record();

  // Enqueue for background generation
  enqueueGeneration({ keywordId: approved.id, query: approved.query });
  logger.info(
    { keyword_id: approved.id, query: approved.query },
    "Generation enqueued"
  );

  return c.json(
    {
      status: "queued",
      keyword_id: approved.id,
      query: approved.query,
      remaining: rateLimiter.remaining(),
    },
    202
  );
});

// Bulk-enqueue multiple approved topics. Atomic single-request enqueue with
// rate-limit clamping — if the user asks for more than remaining quota, only
// the first N (= remaining) get enqueued and the rest come back as skipped.
generate.post("/batch", async (c) => {
  const body = await c.req
    .json<{ keyword_ids?: string[] }>()
    .catch(() => ({ keyword_ids: undefined }));

  if (!body.keyword_ids || !Array.isArray(body.keyword_ids) || body.keyword_ids.length === 0) {
    return c.json({ error: "keyword_ids array required" }, 400);
  }

  // Dedup + cap to 20 to prevent runaway batch sizes
  const uniqueIds = [...new Set(body.keyword_ids)].slice(0, 20);

  const db = getDb();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const approved = db
    .prepare(
      `SELECT k.id, k.query FROM keywords k
       WHERE k.id IN (${placeholders}) AND k.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.keyword_id = k.id)
       ORDER BY k.opportunity_score DESC`
    )
    .all(...uniqueIds) as Array<{ id: string; query: string }>;

  if (approved.length === 0) {
    return c.json({ error: "No matching approved topics waiting for generation" }, 404);
  }

  // Clamp to rate-limit budget
  const remaining = rateLimiter.remaining();
  const toEnqueue = approved.slice(0, remaining);
  const skipped = approved.slice(remaining);

  for (const k of toEnqueue) {
    rateLimiter.record();
    enqueueGeneration({ keywordId: k.id, query: k.query });
  }

  logger.info(
    { enqueued: toEnqueue.length, skipped: skipped.length },
    "Batch generation enqueued"
  );

  return c.json(
    {
      status: "queued",
      enqueued: toEnqueue.map((k) => ({ keyword_id: k.id, query: k.query })),
      skipped: skipped.map((k) => ({ keyword_id: k.id, query: k.query, reason: "rate-limit" })),
      remaining: rateLimiter.remaining(),
    },
    202
  );
});

// Get generation queue status
generate.get("/status", (c) => {
  const queueStatus = getQueueStatus();
  return c.json({
    remaining: rateLimiter.remaining(),
    queue: queueStatus,
  });
});

export { generate };
