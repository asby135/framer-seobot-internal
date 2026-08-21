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
 * dry_run seeds and selects as normal but returns the titles in the response
 * instead of sending the digest — so the pipeline can be exercised without
 * messaging the group.
 *
 * It does NOT skip topic seeding or the rotation cursor advance. Those are real
 * either way, because a rehearsal against an empty pool would prove nothing.
 *
 * Without dry_run the digest is sent and approving a title spends a full
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

    logger.info({ dryRun, proposed: result.proposals?.length ?? 0 }, "Manual autopilot run complete");
    return c.json({
      success: true,
      dryRun,
      titles: result.proposals?.map((p) => p.title) ?? [],
      note: dryRun
        ? "Rehearsal: no digest was sent. The titles below are what would have been proposed. Seeding and the rotation cursor advance are real."
        : "Digest sent. Approving a title starts a real generation.",
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
