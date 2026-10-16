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

/**
 * The calendar date and hour of `d` in `timeZone` (an IANA name), or in the
 * process's own zone when none is given — which on Railway, with no TZ set, is
 * UTC. The operator's evening is not UTC, hence the setting.
 */
function zoned(d: Date, timeZone?: string): { dateKey: string; hour: number } {
  let format: Intl.DateTimeFormat;
  try {
    format = makeFormat(timeZone);
  } catch {
    // An unknown zone (only reachable by editing the DB — the API validates)
    // must not throw: tick() runs from a timer, and a throw there crashed the
    // process on every boot. Fall back to the process zone, loudly.
    logger.error({ timeZone }, "Unknown timezone — using the server's own");
    format = makeFormat(undefined);
  }
  const parts = Object.fromEntries(format.formatToParts(d).map((p) => [p.type, p.value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function makeFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
}

/** Day key used to record "already ran today", in the digest's timezone. */
export function localDateKey(d: Date, timeZone?: string): string {
  return zoned(d, timeZone).dateKey;
}

/**
 * Is a run due?
 *
 * True when the local hour has been reached and today has not run yet. Because
 * the check is "has today run" rather than "is it exactly 20:00", a run missed
 * to downtime fires on the next tick instead of being skipped for the night.
 */
export function shouldRun(now: Date, lastRunDate: string | null, hour: number, timeZone?: string): boolean {
  const here = zoned(now, timeZone);
  if (lastRunDate === here.dateKey) return false;
  return here.hour >= hour;
}

export interface RunnerConfig {
  job: () => Promise<void>;
  /**
   * The hour to run at. A function is re-read on every tick, so a change saved
   * in the plugin applies without a redeploy — read once at boot, it did not.
   */
  hour: number | (() => number);
  /** IANA zone the hour and the day are counted in; the process zone if unset. */
  timeZone?: () => string | undefined;
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
    const hour = typeof config.hour === "function" ? config.hour() : config.hour;
    const timeZone = config.timeZone?.();
    if (!shouldRun(now(), config.getLastRun(), hour, timeZone)) return;

    const today = localDateKey(now(), timeZone);
    if (attemptsDay !== today) {
      attemptsDay = today;
      attempts = 0;
    }
    if (attempts >= maxAttempts) return; // exhausted; already alerted

    attempts++;
    running = true;
    const startedAt = now();
    try {
      logger.info({ date: localDateKey(startedAt, timeZone) }, "Nightly run starting");
      await config.job();
      // Recorded only on success, so a failed night retries on the next tick
      // rather than being marked done.
      config.setLastRun(localDateKey(startedAt, timeZone));
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
      logger.info({ hour: typeof config.hour === "function" ? config.hour() : config.hour, timeZone: config.timeZone?.() ?? "process" }, "Scheduler started");
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
