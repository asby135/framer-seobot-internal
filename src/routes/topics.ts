import { Hono } from "hono";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";

const topics = new Hono();

// List keyword opportunities (scored, ranked)
topics.get("/", (c) => {
  const db = getDb();
  const status = c.req.query("status") || "pending";

  const rows = db
    .prepare(
      `SELECT id, query, source, impressions, clicks, ctr, position,
              search_volume, opportunity_score, status, created_at
       FROM keywords
       WHERE status = ?
       ORDER BY opportunity_score DESC
       LIMIT 50`
    )
    .all(status);

  return c.json({ topics: rows });
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

// Reject a topic
topics.post("/:id/reject", (c) => {
  const db = getDb();
  const { id } = c.req.param();

  const result = db
    .prepare(
      "UPDATE keywords SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
    .run(id);

  if (result.changes === 0) {
    return c.json({ error: "Topic not found or not in pending status" }, 404);
  }

  return c.json({ success: true });
});

// Submit a custom topic
topics.post("/custom", async (c) => {
  const db = getDb();
  const body = await c.req.json<{ query: string }>();

  if (!body.query?.trim()) {
    return c.json({ error: "Query is required" }, 400);
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO keywords (id, query, source, status, opportunity_score)
     VALUES (?, ?, 'custom', 'approved', 0)`
  ).run(id, body.query.trim());

  return c.json({ id, status: "approved" }, 201);
});

export { topics };
