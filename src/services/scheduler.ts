import { logger } from "../lib/logger.js";

/**
 * In-process nightly scheduler.
 *
 * In-process rather than a Railway cron service because Railway cron requires
 * the process to exit, and a separate service could not mount the volume the
 * SQLite database lives on.
 */

/** Poll frequency. The job itself is idempotent per day, so this is cheap. */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Local-day key used to record "already ran today". */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Is a run due?
 *
 * True when the local hour has been reached and today has not run yet. Because
 * the check is "has today run" rather than "is it exactly 20:00", a run missed
 * to downtime fires on the next tick instead of being skipped for the night.
 */
export function shouldRun(now: Date, lastRunDate: string | null, hour: number): boolean {
  const today = localDateKey(now);
  if (lastRunDate === today) return false;
  return now.getHours() >= hour;
}

export interface RunnerConfig {
  job: () => Promise<void>;
  hour: number;
  getLastRun: () => string | null;
  setLastRun: (date: string) => void;
  now?: () => Date;
}

export interface Runner {
  /** Evaluate once and run if due. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createRunner(config: RunnerConfig): Runner {
  const now = config.now ?? (() => new Date());
  let running = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const tick = async (): Promise<void> => {
    // Single-flight: a night that overruns must not collide with the next tick
    // and generate the batch twice.
    if (running) {
      logger.debug("Scheduler tick skipped — a run is already in progress");
      return;
    }
    if (!shouldRun(now(), config.getLastRun(), config.hour)) return;

    running = true;
    const startedAt = now();
    try {
      logger.info({ date: localDateKey(startedAt) }, "Nightly run starting");
      await config.job();
      // Recorded only on success, so a failed night retries on the next tick
      // rather than being marked done.
      config.setLastRun(localDateKey(startedAt));
      logger.info("Nightly run complete");
    } catch (e) {
      logger.error(
        { error: e instanceof Error ? e.message : "unknown" },
        "Nightly run failed — will retry on the next tick"
      );
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (interval) return;
      interval = setInterval(() => void tick(), TICK_INTERVAL_MS);
      // Check immediately on boot so a run missed during downtime is caught.
      void tick();
      logger.info({ hour: config.hour }, "Scheduler started");
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
