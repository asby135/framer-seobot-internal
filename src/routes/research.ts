import { Hono } from "hono";
import { runResearch } from "../services/research.js";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

const research = new Hono();

// Trigger keyword research refresh (pulls from Era / OhMyGEO)
research.post("/", async (c) => {
  try {
    const result = await runResearch();
    return c.json({
      status: "complete",
      discovered: result.discovered,
      skipped: result.skipped,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message }, "Research failed");
    return c.json({ error: message }, 500);
  }
});

// Clear stale keywords by source — e.g. legacy GSC rows after the Era pivot.
// Only deletes 'pending' rows; 'approved'/'generated' rows may have article
// history (articles.keyword_id FK), and 'custom' rows are user-added.
research.delete("/keywords", (c) => {
  const db = getDb();
  const source = c.req.query("source");
  if (!source) {
    return c.json({ error: "source query param required, e.g. ?source=gsc" }, 400);
  }
  const result = db
    .prepare("DELETE FROM keywords WHERE source = ? AND status = 'pending'")
    .run(source);
  logger.info({ source, deleted: result.changes }, "Cleared pending keywords by source");
  return c.json({ status: "complete", source, deleted: result.changes });
});

export { research };
