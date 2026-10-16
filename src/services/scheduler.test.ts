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

describe("createRunner — failure handling", () => {
  const failing = () => async () => { throw new Error("anthropic 529"); };

  it("stops retrying after the attempt cap instead of looping until midnight", async () => {
    // The tick runs every 5 minutes and lastRun is only recorded on success, so
    // an unbounded retry means ~48 runs between 20:00 and midnight — each one
    // proposing titles for 3-10 topics before failing again.
    const job = vi.fn(failing());
    const r = createRunner({
      job, hour: 20, maxAttemptsPerDay: 3,
      getLastRun: () => null, setLastRun: () => {},
      now: () => at(2026, 8, 19, 20),
    });
    for (let i = 0; i < 10; i++) await r.tick();
    expect(job).toHaveBeenCalledTimes(3);
  });

  it("alerts once the attempts are exhausted", async () => {
    const onExhausted = vi.fn(async () => {});
    const r = createRunner({
      job: failing(), hour: 20, maxAttemptsPerDay: 2, onExhausted,
      getLastRun: () => null, setLastRun: () => {},
      now: () => at(2026, 8, 19, 20),
    });
    await r.tick();
    await r.tick();
    await r.tick();
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(String(onExhausted.mock.calls[0][0])).toMatch(/anthropic 529/);
  });

  it("resets the attempt budget on a new day", async () => {
    const job = vi.fn(failing());
    let day = 19;
    const r = createRunner({
      job, hour: 20, maxAttemptsPerDay: 2,
      getLastRun: () => null, setLastRun: () => {},
      now: () => at(2026, 8, day, 20),
    });
    await r.tick();
    await r.tick();
    await r.tick(); // exhausted
    expect(job).toHaveBeenCalledTimes(2);

    day = 20; // next evening
    await r.tick();
    expect(job).toHaveBeenCalledTimes(3);
  });

  it("still retries within the budget, so a transient failure recovers", async () => {
    let calls = 0;
    const job = vi.fn(async () => {
      if (++calls === 1) throw new Error("transient");
    });
    let saved: string | null = null;
    const r = createRunner({
      job, hour: 20, maxAttemptsPerDay: 3,
      getLastRun: () => saved, setLastRun: (d) => { saved = d; },
      now: () => at(2026, 8, 19, 20),
    });
    await r.tick();
    await r.tick();
    expect(job).toHaveBeenCalledTimes(2);
    expect(saved).not.toBeNull(); // succeeded on the retry
  });
});

describe("the digest hour in a named timezone", () => {
  // The hour used to be evaluated in the container's clock (UTC on Railway,
  // no TZ set) while the plugin labelled it "local".
  const utc = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 16, h, m));

  it("runs at 20:00 in the configured zone", () => {
    expect(shouldRun(utc(11), null, 20, "Asia/Tokyo")).toBe(true); // 20:00 in Tokyo
    expect(shouldRun(utc(10, 59), null, 20, "Asia/Tokyo")).toBe(false);
  });

  it("keys the day in the configured zone", () => {
    // 23:30 UTC on the 16th is already the 17th in Tokyo.
    expect(localDateKey(utc(23, 30), "Asia/Tokyo")).toBe("2026-10-17");
    expect(localDateKey(utc(23, 30), "UTC")).toBe("2026-10-16");
  });
});

describe("createRunner reads the hour on every tick", () => {
  it("picks up a changed hour without a restart", async () => {
    // Read once at boot, a change saved in the plugin did nothing until the
    // next deploy.
    let hour = 22;
    const job = vi.fn(async () => {});
    const runner = createRunner({
      job,
      hour: () => hour,
      getLastRun: () => null,
      setLastRun: () => {},
      now: () => at(2026, 8, 19, 21),
    });
    await runner.tick();
    expect(job).not.toHaveBeenCalled();
    hour = 20;
    await runner.tick();
    expect(job).toHaveBeenCalledOnce();
  });
});

describe("a timezone the runtime does not know", () => {
  it("falls back to the process zone instead of throwing", () => {
    // tick() runs from a timer with nothing to catch a throw: a bad stored
    // zone would crash the process on every boot.
    expect(() => shouldRun(new Date(), null, 20, "Mars/Olympus")).not.toThrow();
    expect(localDateKey(new Date(Date.UTC(2026, 9, 16, 12)), "Mars/Olympus")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("createRunner records the day in the configured zone", () => {
  it("stamps lastRunDate with the zone's date", async () => {
    let saved = "";
    const runner = createRunner({
      job: async () => {},
      hour: 0,
      timeZone: () => "Asia/Tokyo",
      getLastRun: () => null,
      setLastRun: (d) => { saved = d; },
      now: () => new Date(Date.UTC(2026, 9, 16, 23, 30)), // already the 17th in Tokyo
    });
    await runner.tick();
    expect(saved).toBe("2026-10-17");
  });
});
