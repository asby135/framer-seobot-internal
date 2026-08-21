import { describe, it, expect, vi } from "vitest";
import { runNightly, type AutopilotDeps } from "./autopilot.js";
import { DEFAULT_NICHES } from "./taxonomy.js";

const topic = (id: string) => ({ id, query: `q-${id}`, source: "seeded" });

/**
 * A pending pool that GROWS when seeding writes to it.
 *
 * The top-up loop re-reads the pool between seeds, so a fake returning a fixed
 * array models a seeder that inserts nothing — the loop would then run to its
 * cap on every test. Reality is that a seed adds ~10 topics, and these fakes
 * have to say so.
 */
function growingPool(start: number, perSeed: number, niche?: string) {
  let n = start;
  return {
    getPending: () =>
      Array.from({ length: n }, (_, i) => ({ ...topic(String(i)), ...(niche ? { niche } : {}) })),
    onSeed: () => {
      n += perSeed;
    },
  };
}

function deps(over: Partial<AutopilotDeps> = {}): AutopilotDeps {
  // The cursor is STATEFUL, as it is in production (setSetting then getSetting
  // against the same row). A fixture where setCursor did not feed getCursor
  // made every seed in a run re-read the same slot.
  let cursor = 0;
  return {
    getNiches: () => DEFAULT_NICHES,
    getCursor: () => cursor,
    setCursor: vi.fn((c: number) => {
      cursor = c;
    }),
    getPending: () => [topic("1"), topic("2"), topic("3")],
    poolThreshold: 10,
    articlesPerNight: () => 2,
    seed: vi.fn(async () => {}),
    getCovered: () => ["covered one"],
    sendTitleDigest: vi.fn(async () => 101),
    saveDigestMessageId: vi.fn(),
    dryRun: false,
    ...over,
  };
}

describe("runNightly", () => {
  it("tops up the pool when it is below threshold, before selecting", async () => {
    const order: string[] = [];
    const pool = growingPool(1, 10); // 1 < threshold, one seed clears it
    const d = deps({
      getPending: pool.getPending,
      seed: vi.fn(async () => { order.push("seed"); pool.onSeed(); }),
      sendTitleDigest: vi.fn(async () => { order.push("digest"); return 1; }),
    });
    await runNightly(d);
    expect(order).toEqual(["seed", "digest"]);
  });

  it("keeps seeding until the pool clears the threshold", async () => {
    // One seed per run could never fill a pool whose threshold sat at or above
    // the batch size — the queue parked on the boundary and stopped topping up
    // for good. 0 -> 6 -> 12 clears a threshold of 11 in two.
    const pool = growingPool(0, 6);
    const d = deps({ getPending: pool.getPending, poolThreshold: 11, seed: vi.fn(async () => pool.onSeed()) });
    await runNightly(d);
    expect(d.seed).toHaveBeenCalledTimes(2);
  });

  it("advances the cursor once per seed, so each seed draws a different slot", async () => {
    const pool = growingPool(0, 6);
    const d = deps({ getPending: pool.getPending, poolThreshold: 11, seed: vi.fn(async () => pool.onSeed()) });
    await runNightly(d);
    const calls = (d.seed as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].niche).not.toBe(calls[1][0].niche);
    expect(d.setCursor).toHaveBeenNthCalledWith(1, 1);
    expect(d.setCursor).toHaveBeenNthCalledWith(2, 2);
  });

  it("stops at the per-run cap rather than spinning when seeding adds nothing", async () => {
    // Every candidate a duplicate: the pool never grows. Bounded, not infinite.
    const pool = growingPool(1, 0);
    const d = deps({ getPending: pool.getPending, seed: vi.fn(async () => pool.onSeed()) });
    await runNightly(d);
    expect(d.seed).toHaveBeenCalledTimes(3);
  });

  it("does not seed when the pool is deep enough", async () => {
    const d = deps({ getPending: () => Array.from({ length: 20 }, (_, i) => topic(String(i))) });
    await runNightly(d);
    expect(d.seed).not.toHaveBeenCalled();
  });

  it("seeds from the rotation slot and advances the cursor", async () => {
    const pool = growingPool(1, 10);
    const d = deps({ getPending: pool.getPending, seed: vi.fn(async () => pool.onSeed()) });
    await runNightly(d);
    expect(d.seed).toHaveBeenCalledOnce();
    const arg = (d.seed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ subniche: expect.any(String), angle: expect.any(String) });
    expect(arg.persona).toContain("Web3"); // first non-probationary niche
    expect(d.setCursor).toHaveBeenCalledWith(1);
  });

  it("passes the already-covered list into seeding", async () => {
    const d = deps({ getPending: () => [topic("1")] });
    await runNightly(d);
    const arg = (d.seed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.covered).toEqual(["covered one"]);
  });

  it("uses the seeded phrase AS the title, with no conversion call", async () => {
    // The second Claude call that rewrote topics into headlines is gone: the
    // seeder now writes finished, task-shaped titles, so converting them was a
    // wasted call and a place for two prompts to drift apart.
    const d = deps({ articlesPerNight: () => 1, getPending: () => [topic("1")] });
    const proposals = await runNightly(d);
    expect(proposals[0].title).toBe("q-1");
    expect(proposals[0].title).toBe(proposals[0].query);
  });

  it("sends one digest containing every proposal", async () => {
    const d = deps({ articlesPerNight: () => 3 });
    await runNightly(d);
    expect(d.sendTitleDigest).toHaveBeenCalledOnce();
    const items = (d.sendTitleDigest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(items).toHaveLength(3);
  });

  it("records the digest message id for in-place edits", async () => {
    const d = deps();
    await runNightly(d);
    expect(d.saveDigestMessageId).toHaveBeenCalledWith(101);
  });

  it("dry run returns the titles instead of sending the digest", async () => {
    const d = deps({ dryRun: true, articlesPerNight: () => 2 });
    const proposals = await runNightly(d);
    expect(proposals).toHaveLength(2);
    expect(d.sendTitleDigest).not.toHaveBeenCalled();
  });

  it("does nothing and sends no digest when no topics are available", async () => {
    const d = deps({ getPending: () => [], seed: vi.fn(async () => {}) });
    expect(await runNightly(d)).toEqual([]);
    expect(d.sendTitleDigest).not.toHaveBeenCalled();
  });

  it("seeds a probationary niche but never auto-selects its topics", async () => {
    const probationPool = growingPool(1, 10, "Web3 / crypto");
    const d = deps({
      getNiches: () => DEFAULT_NICHES.map((n) => ({ ...n, probation: true })),
      getPending: probationPool.getPending,
      seed: vi.fn(async () => probationPool.onSeed()),
    });
    await runNightly(d);

    // Seeding happens — that is how the operator gets something to judge.
    expect(d.seed).toHaveBeenCalledOnce();
    // Selection does not: nothing generates from an unproven niche unattended.
    expect(d.sendTitleDigest).not.toHaveBeenCalled();
  });

  it("records which niche seeded a topic, so probation can be enforced later", async () => {
    const d = deps({ getPending: () => [topic("1")] });
    await runNightly(d);
    const arg = (d.seed as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.niche).toBe("Web3 / crypto");
  });

  it("selects topics from niches that are not on probation", async () => {
    const d = deps({
      getPending: () => [{ id: "ok", query: "fine", source: "seeded", niche: "Web3 / crypto" }],
    });
    expect(await runNightly(d)).toHaveLength(1);
  });

  it("never selects an Era topic", async () => {
    const d = deps({
      getPending: () => [{ id: "e", query: "era topic", source: "era" }],
      articlesPerNight: () => 5,
    });
    expect(await runNightly(d)).toEqual([]);
  });
});

describe("runNightly — title variety", () => {
  it("no longer needs within-batch de-collision, because there is no per-title call", async () => {
    // Batch-level shape collision was a property of generating each headline
    // independently. Titles now come from ONE seeder call that sees the whole
    // batch and is told each must be a different task, so variety is the
    // seeder's job.
    const d = deps({ articlesPerNight: () => 3 });
    const proposals = await runNightly(d);
    expect(new Set(proposals.map((p) => p.title)).size).toBe(proposals.length);
  });
});
