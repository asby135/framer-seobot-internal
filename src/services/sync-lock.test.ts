import { describe, it, expect } from "vitest";
import { createSyncLock } from "./sync-lock.js";

/**
 * The lock around syncToFramer.
 *
 * It used to hand a caller who arrived mid-sync the RUNNING sync's result. That
 * sync had read its list of published articles before the newcomer marked its
 * article published — so the article was never written to Framer, yet the
 * caller was told it was synced, the deploy was armed, and the announcement
 * listed a URL that 404'd. With Framer's ~70s warm-up the window was wide.
 */

/** A run that does not finish until released, recording what it was asked. */
function controllableRun() {
  const calls: Array<{ force: boolean; release: (v?: unknown) => void; fail: (e: Error) => void }> = [];
  let active = 0;
  let maxActive = 0;
  const run = (force: boolean) =>
    new Promise<string>((resolve, reject) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const n = calls.length + 1;
      calls.push({
        force,
        release: () => { active--; resolve(`run${n}`); },
        fail: (e) => { active--; reject(e); },
      });
    });
  return { run, calls, maxActive: () => maxActive };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSyncLock", () => {
  it("runs once for a single caller", async () => {
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    const p = sync(false);
    await tick();
    c.calls[0].release();
    expect(await p).toBe("run1");
    expect(c.calls).toHaveLength(1);
  });

  it("gives a caller who arrives mid-sync a run of its own, after the current one", async () => {
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    const first = sync(false);
    await tick();
    const late = sync(false);
    await tick();
    expect(c.calls).toHaveLength(1); // never two at once

    c.calls[0].release();
    expect(await first).toBe("run1");
    await tick();
    expect(c.calls).toHaveLength(2); // the late caller's run started only now
    c.calls[1].release();
    expect(await late).toBe("run2");
    expect(c.maxActive()).toBe(1);
  });

  it("lets everyone who arrives during one sync share a single follow-up", async () => {
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    void sync(false);
    await tick();
    const a = sync(false);
    const b = sync(false);
    c.calls[0].release();
    await tick();
    c.calls[1].release();
    expect(await a).toBe("run2");
    expect(await b).toBe("run2");
    expect(c.calls).toHaveLength(2);
  });

  it("still runs the follow-up when the current sync fails", async () => {
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    const first = sync(false);
    await tick();
    const late = sync(false);
    c.calls[0].fail(new Error("Framer said no"));
    await expect(first).rejects.toThrow("Framer said no");
    await tick();
    c.calls[1].release();
    expect(await late).toBe("run2");
  });

  it("makes the follow-up a forced rewrite if any caller waiting for it asked for one", async () => {
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    void sync(false);
    await tick();
    void sync(false);
    void sync(true);
    c.calls[0].release();
    await tick();
    expect(c.calls[1].force).toBe(true);
  });

  it("is free again once everything has settled", async () => {
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    const p = sync(false);
    await tick();
    c.calls[0].release();
    await p;
    const q = sync(false);
    await tick();
    expect(c.calls).toHaveLength(2);
    c.calls[1].release();
    expect(await q).toBe("run2");
  });

  it("never runs two syncs at once, even for a caller who re-enters straight after its await", async () => {
    // Between the running sync settling and its queued follow-up starting
    // there are a couple of microtasks where nothing is in flight. A caller
    // landing there must join the follow-up, not start a run beside it.
    const c = controllableRun();
    const sync = createSyncLock(c.run);
    const a = (async () => { await sync(false); await sync(false); })();
    await tick();
    const b = sync(false); // queues the follow-up
    c.calls[0].release();
    await tick();
    while (c.calls.length > 1 && c.calls.some((x, i) => i > 0 && !("done" in x))) {
      const pending = c.calls.filter((x) => !("done" in x)).slice(-1)[0];
      (pending as Record<string, unknown>).done = true;
      pending.release();
      await tick();
    }
    await Promise.all([a, b]);
    expect(c.maxActive()).toBe(1);
  });
});

