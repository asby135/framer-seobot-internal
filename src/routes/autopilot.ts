import { Hono } from "hono";
import { runNightlyOnce } from "../services/bootstrap.js";
import { getSetting } from "../services/settings.js";
import { logger } from "../lib/logger.js";

/**
 * Manual trigger for the nightly run.
 *
 * The scheduler fires once a day at `scheduleHour`, which makes the gate-1
 * flow — rotation-slot seeding, title proposal, the Telegram digest — awkward
 * to exercise deliberately. This runs the identical job on demand.
 *
 * Same reasoning as the sync preview: the first execution of something that
 * spends money and messages the operator should be a human triggering it, not
 * a clock.
 */
const autopilot = new Hono();

/**
 * POST /api/autopilot/run?dry_run=1
 *
 * dry_run skips persisting the proposed titles and the digest message id, so
 * the digest's approve buttons will not find a pinned title and do nothing.
 *
 * It does NOT skip topic seeding or the rotation cursor advance. Those run
 * either way, because a dry run against an empty pool would have nothing to
 * propose and would prove nothing. So a dry run can still cost one Claude call
 * for seeding, plus one per proposed title.
 *
 * Without dry_run the digest is live: approving a title spends a full
 * generation.
 */
autopilot.post("/run", async (c) => {
  const dryRun = c.req.query("dry_run") === "1";

  try {
    const result = await runNightlyOnce(dryRun);

    if (!result.started) {
      // A run is already going. Starting a second would double-propose and
      // send two digests for the same topics.
      return c.json({ error: "a nightly run is already in progress" }, 409);
    }

    logger.info({ dryRun }, "Manual autopilot run complete");
    return c.json({
      success: true,
      dryRun,
      note: dryRun
        ? "Digest sent. Titles were not persisted, so approving from this digest will not generate. Topics may have been seeded and the rotation cursor advanced — those are real."
        : "Digest sent. Approving a title will start a real generation.",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message, dryRun }, "Manual autopilot run failed");
    return c.json({ error: message }, 500);
  }
});

/** Current pipeline state, for checking what a run would do. */
autopilot.get("/status", (c) => {
  return c.json({
    scheduleHour: getSetting("scheduleHour", 20),
    lastRunDate: getSetting<string | null>("lastRunDate", null),
    rotationCursor: getSetting("rotationCursor", 0),
    minPerNight: getSetting("minPerNight", 5),
    maxPerNight: getSetting("maxPerNight", 10),
    poolThreshold: getSetting("poolThreshold", 10),
    autopilotEnabled: process.env.AUTOPILOT_ENABLED === "1",
    schedulerDryRun: process.env.SCHEDULER_DRY_RUN === "1",
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  });
});

export { autopilot };
