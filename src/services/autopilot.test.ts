import { describe, it, expect, vi } from "vitest";
import { runNightly, type AutopilotDeps } from "./autopilot.js";
import { DEFAULT_NICHES } from "./taxonomy.js";

const topic = (id: string) => ({ id, query: `q-${id}`, source: "seeded" });

function deps(over: Partial<AutopilotDeps> = {}): AutopilotDeps {
  return {
    getNiches: () => DEFAULT_NICHES,
    getCursor: () => 0,
    setCursor: vi.fn(),
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
    const d = deps({
      getPending: () => [topic("1")], // 1 < threshold
      seed: vi.fn(async () => { order.push("seed"); }),
      sendTitleDigest: vi.fn(async () => { order.push("digest"); return 1; }),
    });
    await runNightly(d);
    expect(order).toEqual(["seed", "digest"]);
  });

  it("does not seed when the pool is deep enough", async () => {
    const d = deps({ getPending: () => Array.from({ length: 20 }, (_, i) => topic(String(i))) });
    await runNightly(d);
    expect(d.seed).not.toHaveBeenCalled();
  });

  it("seeds from the rotation slot and advances the cursor", async () => {
    const d = deps({ getPending: () => [topic("1")] });
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
    const d = deps({
      getNiches: () => DEFAULT_NICHES.map((n) => ({ ...n, probation: true })),
      getPending: () => [{ id: "p", query: "probation topic", source: "seeded", niche: "Web3 / crypto" }],
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
