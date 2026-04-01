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

  // Don't enqueue if generation is already running
  const queueStatus = getQueueStatus();
  if (queueStatus.active > 0 || queueStatus.pending > 0) {
    return c.json(
      {
        error: "Generation already in progress",
        queue: queueStatus,
        remaining: rateLimiter.remaining(),
      },
      409
    );
  }

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

// Get generation queue status
generate.get("/status", (c) => {
  const queueStatus = getQueueStatus();
  return c.json({
    remaining: rateLimiter.remaining(),
    queue: queueStatus,
  });
});

export { generate };
