import { Hono } from "hono";
import { runResearch } from "../services/research.js";
import { calculateOpportunityScore } from "../services/scoring.js";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

const research = new Hono();

// Trigger keyword research refresh
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

// Re-score all keywords with current scoring formula
research.post("/rescore", (c) => {
  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT id, impressions, ctr, position FROM keywords")
      .all() as Array<{ id: string; impressions: number; ctr: number; position: number }>;

    const update = db.prepare(
      "UPDATE keywords SET opportunity_score = ? WHERE id = ?"
    );

    const updateAll = db.transaction(() => {
      for (const row of rows) {
        const score = calculateOpportunityScore({
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        });
        update.run(score, row.id);
      }
    });

    updateAll();

    logger.info({ count: rows.length }, "Keywords re-scored");
    return c.json({ status: "complete", rescored: rows.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message }, "Re-score failed");
    return c.json({ error: message }, 500);
  }
});

export { research };
