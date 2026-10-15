import { describe, it, expect, vi } from "vitest";
process.env.ANTHROPIC_API_KEY ??= "test";
const { dropSemanticDuplicates, parseDuplicateVerdicts } = await import("./seeder.js");

/**
 * Duplicates the word-overlap guard cannot see.
 *
 * Live on the blog: "How to Set Up a Telegram Channel to Deliver Forex Trading
 * Signals" and "How to Set Up a Telegram Channel for Distributing Forex
 * Signals" — the same article, sharing too few words to score as one.
 * Shortlisting by word overlap and asking a model to judge only the shortlist
 * catches these for the cost of one small call per seed.
 */
const CORPUS = [
  "How to Set Up a Telegram Channel for Distributing Forex Signals",
  "How to Write a Chatter Shift Handoff Note for an Ongoing Fan Chat",
  "Why Telegram Accounts Get Banned for Bulk Messaging",
];

describe("dropSemanticDuplicates", () => {
  it("offers each candidate's nearest existing titles to the judge, and drops what it calls a duplicate", async () => {
    const judge = vi.fn(async (items: Array<{ candidate: string; neighbors: string[] }>) =>
      items.map((i) => (i.candidate.includes("Forex") ? i.neighbors[0] : null))
    );
    const r = await dropSemanticDuplicates(
      ["How to Set Up a Telegram Channel to Deliver Forex Trading Signals", "How to Write a Chatter Shift Handoff Note So No Fan Message Gets Missed"],
      CORPUS,
      judge
    );
    expect(judge.mock.calls[0][0][0].neighbors).toContain(CORPUS[0]);
    expect(r.kept).toEqual(["How to Write a Chatter Shift Handoff Note So No Fan Message Gets Missed"]);
    expect(r.dropped).toEqual([{ query: "How to Set Up a Telegram Channel to Deliver Forex Trading Signals", matched: CORPUS[0] }]);
  });

  it("does not call the judge when no candidate has a near neighbour", async () => {
    const judge = vi.fn();
    const r = await dropSemanticDuplicates(["How to Price a Custom ML Model for a Client"], CORPUS, judge);
    expect(judge).not.toHaveBeenCalled();
    expect(r.kept).toHaveLength(1);
  });

  it("ignores a verdict naming a title that was not offered", async () => {
    const judge = vi.fn(async (items: unknown[]) => items.map(() => "Some Title Nobody Offered"));
    const r = await dropSemanticDuplicates(["How to Set Up a Telegram Channel to Deliver Forex Trading Signals"], CORPUS, judge);
    expect(r.kept).toHaveLength(1);
  });

  it("keeps every candidate when the judge fails — the word-overlap guard still runs", async () => {
    const judge = vi.fn(async () => { throw new Error("529 overloaded"); });
    const r = await dropSemanticDuplicates(["How to Set Up a Telegram Channel to Deliver Forex Trading Signals"], CORPUS, judge);
    expect(r.kept).toHaveLength(1);
  });

  it("lets the judge see different-task titles on the same subject", () => {
    // The word guard's task distinctions are for its own hard refusals; the
    // judge is told setup-vs-fix is not a repeat and decides borderline pairs.
    const judge = vi.fn(async (items: unknown[]) => items.map(() => null));
    return dropSemanticDuplicates(["How to Recover a Banned Telegram Account"], CORPUS, judge).then(() => {
      const offered = (judge.mock.calls[0]?.[0] ?? []) as Array<{ neighbors: string[] }>;
      expect(offered.flatMap((i) => i.neighbors)).toContain(CORPUS[2]);
    });
  });

  it("matches a verdict that differs only in case or spacing", async () => {
    const judge = vi.fn(async (items: Array<{ neighbors: string[] }>) => items.map((i) => `  ${i.neighbors[0].toUpperCase()} `));
    const r = await dropSemanticDuplicates(["How to Set Up a Telegram Channel to Deliver Forex Trading Signals"], CORPUS, judge);
    expect(r.dropped[0]?.matched).toBe(CORPUS[0]);
  });

  it("does not spend the judge on exact repeats — the insert step refuses those", async () => {
    const judge = vi.fn(async (items: unknown[]) => items.map(() => null));
    await dropSemanticDuplicates([CORPUS[0].toLowerCase()], CORPUS, judge);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("parseDuplicateVerdicts", () => {
  it("reads one verdict per item, by index", () => {
    expect(parseDuplicateVerdicts({ results: [{ index: 1, duplicate_of: "B" }, { index: 0, duplicate_of: null }] }, 2)).toEqual([null, "B"]);
  });

  it("treats a malformed payload as no duplicates", () => {
    expect(parseDuplicateVerdicts(undefined, 2)).toEqual([null, null]);
    expect(parseDuplicateVerdicts({ results: [{ index: 9, duplicate_of: "X" }] }, 1)).toEqual([null]);
  });
});
