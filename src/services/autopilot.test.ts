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
    recentTitles: () => ["Recent Title"],
    proposeTitle: vi.fn(async (t: string) => `Headline for ${t}`),
    saveProposedTitle: vi.fn(),
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
      proposeTitle: vi.fn(async (t: string) => { order.push("title"); return `H ${t}`; }),
    });
    await runNightly(d);
    expect(order[0]).toBe("seed");
    expect(order).toContain("title");
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

  it("proposes one title per selected topic", async () => {
    const d = deps({ articlesPerNight: () => 2 });
    await runNightly(d);
    expect(d.proposeTitle).toHaveBeenCalledTimes(2);
  });

  it("persists each proposed title so approval can pin it later", async () => {
    const d = deps({ articlesPerNight: () => 1 });
    await runNightly(d);
    expect(d.saveProposedTitle).toHaveBeenCalledTimes(1);
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

  it("stops after the digest in dry-run mode without persisting anything", async () => {
    const d = deps({ dryRun: true });
    await runNightly(d);
    expect(d.proposeTitle).toHaveBeenCalled();
    expect(d.sendTitleDigest).toHaveBeenCalled();
    expect(d.saveProposedTitle).not.toHaveBeenCalled();
  });

  it("does nothing and sends no digest when no topics are available", async () => {
    const d = deps({ getPending: () => [], seed: vi.fn(async () => {}) });
    await runNightly(d);
    expect(d.proposeTitle).not.toHaveBeenCalled();
    expect(d.sendTitleDigest).not.toHaveBeenCalled();
  });

  it("skips seeding when every niche is on probation", async () => {
    const d = deps({
      getNiches: () => DEFAULT_NICHES.map((n) => ({ ...n, probation: true })),
      getPending: () => [topic("1")],
    });
    await runNightly(d);
    expect(d.seed).not.toHaveBeenCalled();
    // Still proposes from whatever is already pending.
    expect(d.proposeTitle).toHaveBeenCalled();
  });

  it("never selects an Era topic", async () => {
    const d = deps({
      getPending: () => [{ id: "e", query: "era topic", source: "era" }],
      articlesPerNight: () => 5,
    });
    await runNightly(d);
    expect(d.proposeTitle).not.toHaveBeenCalled();
  });
});
