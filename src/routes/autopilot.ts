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
 * dry_run proposes titles and sends the digest but persists nothing — no
 * approved keywords, no stored proposals, no advanced rotation cursor. Safe to
 * repeat.
 *
 * Without dry_run it is the real thing: it may seed topics (one Claude call),
 * proposes a title per selected topic (one call each), and sends a digest whose
 * buttons will spend a full generation when tapped.
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
        ? "Digest sent. Nothing was persisted — approving from this digest will not work."
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
