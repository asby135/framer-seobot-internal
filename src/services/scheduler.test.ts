import { describe, it, expect, vi } from "vitest";
import { shouldRun, localDateKey, createRunner } from "./scheduler.js";

/**
 * Build a LOCAL-time date. shouldRun reads local hours (the operator's evening
 * is what matters, not UTC), so tests must construct local times or they pass
 * or fail depending on the machine's timezone.
 */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

describe("shouldRun", () => {
  it("runs at the scheduled hour on a fresh day", () => {
    expect(shouldRun(at(2026, 8, 19, 20), null, 20)).toBe(true);
  });

  it("runs after the scheduled hour when the day has not run yet", () => {
    expect(shouldRun(at(2026, 8, 19, 22, 30), null, 20)).toBe(true);
  });

  it("does not run before the scheduled hour", () => {
    expect(shouldRun(at(2026, 8, 19, 19, 59), null, 20)).toBe(false);
  });

  it("does not run twice on the same day", () => {
    expect(shouldRun(at(2026, 8, 19, 22), "2026-08-19", 20)).toBe(false);
  });

  it("runs again on the next day", () => {
    expect(shouldRun(at(2026, 8, 20, 20), "2026-08-19", 20)).toBe(true);
  });

  it("recovers a run missed to downtime later the same evening", () => {
    // Railway restarted through the 20:00 slot and came back at 22:00 — the
    // night is still recoverable, so it runs rather than being skipped.
    expect(shouldRun(at(2026, 8, 19, 22), null, 20)).toBe(true);
  });

  it("defers to the next evening rather than firing overnight", () => {
    // Down through the whole evening, back at 03:00. Deliberately does NOT run:
    // the digest would arrive at 3am and generation would land mid-workday.
    // One skipped night beats an off-cycle 3am notification.
    expect(shouldRun(at(2026, 8, 21, 3), "2026-08-19", 20)).toBe(false);
  });

  it("does not fire early in the morning of a day that has not reached the hour", () => {
    expect(shouldRun(at(2026, 8, 20, 3), "2026-08-20", 20)).toBe(false);
  });
});

describe("localDateKey", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(localDateKey(at(2026, 8, 19, 20))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is stable across the same day", () => {
    expect(localDateKey(at(2026, 8, 19, 20))).toBe(localDateKey(at(2026, 8, 19, 21)));
  });
});

describe("createRunner", () => {
  it("runs the job when due", async () => {
    const job = vi.fn(async () => {});
    let saved: string | null = null;
    const r = createRunner({
      job,
      hour: 20,
      getLastRun: () => saved,
      setLastRun: (d) => { saved = d; },
      now: () => at(2026, 8, 19, 20),
    });
    await r.tick();
    expect(job).toHaveBeenCalledOnce();
    expect(saved).toBe(localDateKey(at(2026, 8, 19, 20)));
  });

  it("does not run when not due", async () => {
    const job = vi.fn(async () => {});
    const r = createRunner({
      job, hour: 20,
      getLastRun: () => null,
      setLastRun: () => {},
      now: () => at(2026, 8, 19, 10),
    });
    await r.tick();
    expect(job).not.toHaveBeenCalled();
  });

  it("holds a single-flight lock so an overrunning night cannot double-run", async () => {
    let release!: () => void;
    const job = vi.fn(() => new Promise<void>((res) => { release = res; }));
    const r = createRunner({
      job, hour: 20,
      getLastRun: () => null,
      setLastRun: () => {},
      now: () => at(2026, 8, 19, 20),
    });
    const first = r.tick();
    await r.tick(); // second tick while the first is still running
    expect(job).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it("records the run date only after the job succeeds", async () => {
    let saved: string | null = null;
    const r = createRunner({
      job: async () => { throw new Error("seeder down"); },
      hour: 20,
      getLastRun: () => saved,
      setLastRun: (d) => { saved = d; },
      now: () => at(2026, 8, 19, 20),
    });
    await r.tick();
    // Left unset so the next tick retries rather than skipping the night.
    expect(saved).toBeNull();
  });

  it("releases the lock after a failure", async () => {
    const job = vi.fn(async () => { throw new Error("boom"); });
    const r = createRunner({
      job, hour: 20,
      getLastRun: () => null,
      setLastRun: () => {},
      now: () => at(2026, 8, 19, 20),
    });
    await r.tick();
    await r.tick();
    expect(job).toHaveBeenCalledTimes(2);
  });
});
