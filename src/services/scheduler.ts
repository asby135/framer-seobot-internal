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
  /**
   * How many times to attempt the job in one day before giving up.
   *
   * The tick runs every 5 minutes and the run date is only recorded on success,
   * so an uncapped failure retries roughly 48 times between 20:00 and midnight
   * — each attempt proposing titles for 3-10 topics, at cost, before failing
   * again. Three attempts covers a transient blip; more is thrashing.
   */
  maxAttemptsPerDay?: number;
  /** Called once when the day's attempts are exhausted. */
  onExhausted?: (message: string) => Promise<void>;
}

export interface Runner {
  /** Evaluate once and run if due. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export function createRunner(config: RunnerConfig): Runner {
  const now = config.now ?? (() => new Date());
  const maxAttempts = config.maxAttemptsPerDay ?? DEFAULT_MAX_ATTEMPTS;

  let running = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  // Attempts are budgeted per local day, so a bad night cannot bleed into the
  // next one and a new evening always starts fresh.
  let attemptsDay: string | null = null;
  let attempts = 0;

  const tick = async (): Promise<void> => {
    // Single-flight: a night that overruns must not collide with the next tick
    // and generate the batch twice.
    if (running) {
      logger.debug("Scheduler tick skipped — a run is already in progress");
      return;
    }
    if (!shouldRun(now(), config.getLastRun(), config.hour)) return;

    const today = localDateKey(now());
    if (attemptsDay !== today) {
      attemptsDay = today;
      attempts = 0;
    }
    if (attempts >= maxAttempts) return; // exhausted; already alerted

    attempts++;
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
      const message = e instanceof Error ? e.message : "unknown";
      const exhausted = attempts >= maxAttempts;

      logger.error(
        { error: message, attempt: attempts, maxAttempts, exhausted },
        exhausted
          ? "Nightly run failed and attempts are exhausted — giving up until tomorrow"
          : "Nightly run failed — will retry on the next tick"
      );

      if (exhausted && config.onExhausted) {
        // Only place the operator learns the night produced nothing. Without
        // it, a failed run is a log line nobody reads.
        await config.onExhausted(
          `Nightly run failed ${attempts} times and gave up. Last error: ${message}`
        );
      }
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
