import { describe, it, expect, vi } from "vitest";
import { runNightly, SEED_BATCH_SIZE, MAX_SEEDS_PER_RUN, PROBATION_SAMPLE_SIZE, type AutopilotDeps } from "./autopilot.js";
import type { PendingTopic } from "./selection.js";
import { DEFAULT_NICHES } from "./taxonomy.js";

const topic = (id: string) => ({ id, query: `q-${id}`, source: "seeded" });

/**
 * A pending pool that GROWS when seeding writes to it.
 *
 * The top-up loop re-reads the pool between seeds, so a fake returning a fixed
 * array models a seeder that inserts nothing — the loop would then run to its
 * cap on every test. Reality is that a seed adds a handful of topics, and these
 * fakes have to say so.
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
    recordProposals: vi.fn(),
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
    expect(d.seed).toHaveBeenCalledTimes(MAX_SEEDS_PER_RUN);
  });

  it("asks each slot for a small batch, so a night's pool spans several niches", async () => {
    // Ten titles from one slot are ten siblings: one subniche, one article
    // type. Filling the pool from three slots of ten made every digest read as
    // two or three subjects. Small batches from more slots is the same number
    // of topics drawn from more places.
    const pool = growingPool(0, SEED_BATCH_SIZE);
    const d = deps({ getPending: pool.getPending, seed: vi.fn(async () => pool.onSeed()) });
    await runNightly(d);
    const calls = (d.seed as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.every((c) => c.count === SEED_BATCH_SIZE)).toBe(true);
    expect(calls).toHaveLength(Math.ceil(10 / SEED_BATCH_SIZE));
    expect(new Set(calls.map((c) => c.niche)).size).toBe(calls.length);
  });

  it("can refill the largest night the settings allow in a single run", () => {
    // maxPerNight is capped at 20 (routes/settings.ts). If one run could seed
    // fewer topics than one night can consume, the pool would shrink every
    // night until the digest ran short.
    expect(SEED_BATCH_SIZE * MAX_SEEDS_PER_RUN).toBeGreaterThanOrEqual(20);
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
    // A realistic pool (each seed lands in its slot's niche); the old fixture
    // tagged every seeded topic with one niche, which no longer models top-up.
    const all = DEFAULT_NICHES.map((n) => ({ ...n, probation: true }));
    const pool = livePool();
    const d = deps({ getNiches: () => all, getPending: pool.getPending, seed: pool.seed });
    await runNightly(d);

    // Seeding happens — that is how the operator gets something to judge —
    // bounded per run, and each niche only up to its review sample.
    expect(pool.seed).toHaveBeenCalled();
    expect(pool.seed.mock.calls.length).toBeLessThanOrEqual(MAX_SEEDS_PER_RUN);
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

describe("recording the proposed titles", () => {
  it("records every proposal before the digest is sent", async () => {
    // Approve All selects tonight's topics by proposed_title, and approving a
    // title pins it as the article's headline. Both read a column that stopped
    // being written when the topic-to-title conversion was removed: Approve All
    // silently matched nothing, and generation invented its own title over the
    // one the operator approved.
    const order: string[] = [];
    const pool = growingPool(20, 0);
    const d = deps({
      getPending: pool.getPending,
      recordProposals: vi.fn(() => {
        order.push("record");
      }),
      sendTitleDigest: vi.fn(async () => {
        order.push("digest");
        return 1;
      }),
    });
    await runNightly(d);

    expect(order).toEqual(["record", "digest"]);
    const recorded = (d.recordProposals as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(recorded.length).toBeGreaterThan(0);
    for (const p of recorded) expect(p.title).toBe(p.query);
  });

  it("records nothing on a dry run, which sends no digest to act on", async () => {
    const pool = growingPool(20, 0);
    const d = deps({ getPending: pool.getPending, dryRun: true });
    await runNightly(d);
    expect(d.recordProposals).not.toHaveBeenCalled();
  });

  it("records nothing when there was nothing to propose", async () => {
    const d = deps({ getPending: () => [] });
    await runNightly(d);
    expect(d.recordProposals).not.toHaveBeenCalled();
  });
});

/**
 * A pool that seeding really writes into, tagged with the slot's niche, so
 * probation and top-up interact the way they do in production.
 */
function livePool(initial: PendingTopic[] = []) {
  const rows: PendingTopic[] = [...initial];
  let n = 0;
  return {
    rows,
    getPending: () => rows,
    seed: vi.fn(async (req: { niche: string }) => {
      for (let i = 0; i < SEED_BATCH_SIZE; i++) {
        n++;
        rows.push({ id: `s${n}`, query: `seeded ${n}`, source: "seeded", niche: req.niche });
      }
    }),
  };
}
const inNiche = (niche: string, count: number, prefix = niche): PendingTopic[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, query: `${prefix} ${i}`, source: "seeded", niche }));

const PROBATION = DEFAULT_NICHES.filter((n) => n.probation).map((n) => n.name);

describe("runNightly — probationary niches cannot stall the digest", () => {
  it("still tops up and sends a digest when probationary topics fill the pool", async () => {
    // The stall: 20+ unoffered probationary topics read as a full pool, so
    // seeding stopped, selection (which skips probation) found nothing, and
    // every night after that sent no digest and said nothing.
    const pool = livePool(PROBATION.flatMap((n) => inNiche(n, 8)));
    const d = deps({ getPending: pool.getPending, seed: pool.seed, poolThreshold: 20 });
    const proposals = await runNightly(d);
    expect(pool.seed).toHaveBeenCalled();
    expect(proposals.length).toBeGreaterThan(0);
    expect(d.sendTitleDigest).toHaveBeenCalledOnce();
  });

  it("stops seeding a probationary niche once it has a sample waiting for review", async () => {
    let cursor = 5; // RU B2B SaaS — the first probationary slot in lap 0
    const pool = livePool(PROBATION.flatMap((n) => inNiche(n, PROBATION_SAMPLE_SIZE)));
    const d = deps({
      getPending: pool.getPending,
      seed: pool.seed,
      getCursor: () => cursor,
      setCursor: vi.fn((c: number) => { cursor = c; }),
    });
    await runNightly(d);
    const seeded = pool.seed.mock.calls.map((c) => c[0].niche);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.some((n) => PROBATION.includes(n))).toBe(false);
  });

  it("keeps seeding a probationary niche that has no sample yet", async () => {
    // Probation exists so the operator can judge a niche's output — it has to
    // produce some.
    let cursor = 5;
    const pool = livePool();
    const d = deps({
      getPending: pool.getPending,
      seed: pool.seed,
      getCursor: () => cursor,
      setCursor: vi.fn((c: number) => { cursor = c; }),
    });
    await runNightly(d);
    expect(pool.seed.mock.calls[0][0].niche).toBe("RU B2B SaaS");
  });

  it("does not spin when every niche is on probation and each already has its sample", async () => {
    const all = DEFAULT_NICHES.map((n) => ({ ...n, probation: true }));
    const pool = livePool(all.flatMap((n) => inNiche(n.name, PROBATION_SAMPLE_SIZE)));
    const d = deps({ getNiches: () => all, getPending: pool.getPending, seed: pool.seed });
    const proposals = await runNightly(d);
    expect(pool.seed).not.toHaveBeenCalled();
    expect(proposals).toEqual([]);
  });

  it("tells the operator when there is nothing to propose, and why", async () => {
    const pool = livePool(inNiche("RU B2B SaaS", 5));
    const notify = vi.fn(async () => {});
    const d = deps({ getPending: pool.getPending, seed: vi.fn(async () => {}), notify });
    await runNightly(d);
    expect(d.sendTitleDigest).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(String((notify.mock.calls[0] as unknown[])[0])).toMatch(/probation/i);
  });

  it("stays quiet on a dry run", async () => {
    const notify = vi.fn(async () => {});
    const d = deps({ getPending: () => [], seed: vi.fn(async () => {}), notify, dryRun: true });
    await runNightly(d);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("runNightly — a failed seed does not cost the night", () => {
  it("sends the digest from the existing pool when seeding fails", async () => {
    // The pool target is two nights deep, so a night usually starts below it
    // but with plenty to propose. One Anthropic 5xx used to throw out of the
    // top-up and take the whole digest with it.
    const pool = livePool(inNiche("Web3 / crypto", 8));
    const d = deps({
      getPending: pool.getPending,
      poolThreshold: 20,
      seed: vi.fn(async () => { throw new Error("529 overloaded"); }),
    });
    const proposals = await runNightly(d);
    expect(d.seed).toHaveBeenCalledOnce(); // gives up seeding after the first failure
    expect(proposals.length).toBeGreaterThan(0);
    expect(d.sendTitleDigest).toHaveBeenCalledOnce();
  });

  it("does not advance the cursor past a slot that failed to seed", async () => {
    const d = deps({ getPending: () => inNiche("Web3 / crypto", 3), seed: vi.fn(async () => { throw new Error("boom"); }) });
    await runNightly(d);
    expect(d.setCursor).not.toHaveBeenCalled();
  });

  it("fails the run when seeding failed AND there is nothing to propose, so the scheduler retries", async () => {
    const d = deps({ getPending: () => [], seed: vi.fn(async () => { throw new Error("529 overloaded"); }) });
    await expect(runNightly(d)).rejects.toThrow("529 overloaded");
  });
});

describe("runNightly — niches that are no longer configured", () => {
  it("does not auto-select topics from a niche that was renamed or removed", async () => {
    const pool = livePool([...inNiche("Removed niche", 6), ...inNiche("Web3 / crypto", 6)]);
    const d = deps({ getPending: pool.getPending, seed: pool.seed, articlesPerNight: () => 10 });
    const proposals = await runNightly(d);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.some((p) => p.keywordId.startsWith("Removed niche"))).toBe(false);
  });
});

describe("the digest's identity and a failed send", () => {
  it("hands the digest id from recording to sending, for the Approve-all button", async () => {
    const d = deps({ recordProposals: vi.fn(() => "dig-9") });
    await runNightly(d);
    expect((d.sendTitleDigest as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("dig-9");
  });

  it("un-records the proposals when the digest could not be sent", async () => {
    // Recorded first so the buttons work; but a digest nobody saw must not
    // leave its topics marked as already offered.
    const forgetProposals = vi.fn();
    const d = deps({
      recordProposals: vi.fn(() => "dig-9"),
      sendTitleDigest: vi.fn(async () => { throw new Error("Telegram rejected the digest"); }),
      forgetProposals,
    });
    await expect(runNightly(d)).rejects.toThrow(/Telegram/);
    expect(forgetProposals).toHaveBeenCalledOnce();
    expect(forgetProposals.mock.calls[0][1]).toBe("dig-9");
  });
});
