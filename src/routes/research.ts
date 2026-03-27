import { Hono } from "hono";
import { runResearch } from "../services/research.js";
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

export { research };
