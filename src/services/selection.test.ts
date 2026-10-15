import { describe, it, expect } from "vitest";
import { selectTopics, needsTopUp, usableTopics, poolTarget, type PendingTopic } from "./selection.js";

const t = (id: string, source: string): PendingTopic => ({ id, query: `q-${id}`, source });

describe("usableTopics", () => {
  it("keeps seeded and custom topics", () => {
    expect(usableTopics([t("1", "seeded"), t("2", "custom")])).toHaveLength(2);
  });

  it("drops every Era-derived and legacy source", () => {
    const pool = [t("1", "era"), t("2", "era-gap"), t("3", "gsc")];
    expect(usableTopics(pool)).toHaveLength(0);
  });

  it("drops unknown sources rather than defaulting to usable", () => {
    // Fail closed: a source we do not recognise must not reach generation.
    expect(usableTopics([t("1", "some-future-source")])).toHaveLength(0);
  });
});

describe("selectTopics", () => {
  it("never selects an Era topic even when the pool is otherwise empty", () => {
    const picked = selectTopics([t("1", "era"), t("2", "era-gap"), t("3", "gsc")], 5, () => 0);
    expect(picked).toEqual([]);
  });

  it("selects only the usable topics from a mixed pool", () => {
    const picked = selectTopics(
      [t("1", "era"), t("2", "seeded"), t("3", "gsc"), t("4", "custom")],
      5,
      () => 0
    );
    expect(picked.map((p) => p.id).sort()).toEqual(["2", "4"]);
  });

  it("never returns more than the requested count", () => {
    const pool = Array.from({ length: 20 }, (_, i) => t(String(i), "seeded"));
    expect(selectTopics(pool, 7, () => 0)).toHaveLength(7);
  });

  it("returns everything available when the pool is smaller than the count", () => {
    expect(selectTopics([t("1", "seeded")], 10, () => 0)).toHaveLength(1);
  });

  it("returns an empty array for a zero count", () => {
    expect(selectTopics([t("1", "seeded")], 0, () => 0)).toEqual([]);
  });

  it("never returns the same topic twice", () => {
    const pool = Array.from({ length: 5 }, (_, i) => t(String(i), "seeded"));
    const ids = selectTopics(pool, 5, () => 0.999).map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("is deterministic under an injected RNG", () => {
    const pool = [t("a", "seeded"), t("b", "seeded"), t("c", "seeded")];
    expect(selectTopics(pool, 1, () => 0)).toEqual([pool[0]]);
  });

  it("does not mutate the caller's array", () => {
    const pool = [t("a", "seeded"), t("b", "seeded")];
    selectTopics(pool, 2, () => 0);
    expect(pool).toHaveLength(2);
  });

  it("tolerates an rng returning exactly 1 without going out of bounds", () => {
    const pool = [t("a", "seeded"), t("b", "seeded")];
    expect(selectTopics(pool, 2, () => 1)).toHaveLength(2);
  });
});

describe("needsTopUp", () => {
  it("tops up when the usable pool is below the threshold", () => {
    expect(needsTopUp([t("1", "seeded")], 10)).toBe(true);
  });

  it("ignores Era rows when measuring the pool", () => {
    // 50 Era rows are not runway — this was the trap that made the pool look
    // three months deep when it held five usable topics.
    const pool = Array.from({ length: 50 }, (_, i) => t(String(i), "era"));
    expect(needsTopUp(pool, 10)).toBe(true);
  });

  it("does not top up when there are enough usable topics", () => {
    const pool = Array.from({ length: 12 }, (_, i) => t(String(i), "seeded"));
    expect(needsTopUp(pool, 10)).toBe(false);
  });

  it("treats exactly-at-threshold as sufficient", () => {
    const pool = Array.from({ length: 10 }, (_, i) => t(String(i), "seeded"));
    expect(needsTopUp(pool, 10)).toBe(false);
  });
});

describe("probation filtering", () => {
  const withNiche = (id: string, niche: string | null) => ({
    id, query: `q-${id}`, source: "seeded", niche,
  });
  const onProbation = new Set(["Online currency exchanges"]);

  it("excludes topics from a probationary niche", () => {
    expect(usableTopics([withNiche("a", "Online currency exchanges")], onProbation)).toHaveLength(0);
  });

  it("keeps topics from a niche that is not on probation", () => {
    expect(usableTopics([withNiche("a", "Web3 / crypto")], onProbation)).toHaveLength(1);
  });

  it("FAILS OPEN on a null niche — legacy rows predate the column", () => {
    // Documented, not accidental: rows written before the niche column exists
    // cannot be attributed, so probation cannot bind them. Contrast with
    // USABLE_SOURCES, which deliberately fails CLOSED on unknown sources.
    expect(usableTopics([withNiche("legacy", null)], onProbation)).toHaveLength(1);
  });

  it("selectTopics honours the exclusion set", () => {
    const pool = [withNiche("a", "Online currency exchanges"), withNiche("b", "Web3 / crypto")];
    expect(selectTopics(pool, 5, () => 0, onProbation).map((t) => t.id)).toEqual(["b"]);
  });

  it("needsTopUp does not count probationary topics as runway", () => {
    // Regression: counting them meant a pool full of topics selection can never
    // pick looked full, so seeding stopped and the digest went silent for good.
    // (The unbounded-seeding problem that counting them used to prevent is now
    // handled by capping each probationary niche's sample — see autopilot.)
    const pool = Array.from({ length: 12 }, (_, i) => withNiche(String(i), "Online currency exchanges"));
    expect(needsTopUp(pool, 10, onProbation)).toBe(true);
    expect(needsTopUp(pool, 10)).toBe(false); // no exclusion set: legacy behaviour
  });
});

describe("topics already offered at gate 1", () => {
  const fresh = (id: string): PendingTopic => ({ id, query: `q-${id}`, source: "seeded" });
  const offered = (id: string): PendingTopic => ({
    id,
    query: `q-${id}`,
    source: "seeded",
    proposedTitle: `q-${id}`,
  });

  it("does not re-offer a topic while unoffered ones remain", () => {
    // The bug: a digest topic the operator neither approved nor rejected stays
    // 'pending', so it was eligible again the next night — and the same handful
    // of areas came round night after night while the rest of the queue was
    // never proposed at all.
    const pool = [offered("old1"), offered("old2"), fresh("new1"), fresh("new2")];
    const picked = selectTopics(pool, 2, () => 0);
    expect(picked.map((p) => p.id).sort()).toEqual(["new1", "new2"]);
  });

  it("falls back to previously offered topics rather than sending an empty digest", () => {
    // Only when there is genuinely nothing new: silence tells the operator
    // nothing, and they can still ignore a repeat.
    const pool = [offered("old1"), offered("old2")];
    expect(selectTopics(pool, 2, () => 0)).toHaveLength(2);
  });

  it("tops the night up from offered topics once the fresh ones run out", () => {
    const pool = [fresh("new1"), offered("old1"), offered("old2")];
    const picked = selectTopics(pool, 3, () => 0);
    expect(picked).toHaveLength(3);
    expect(picked[0].id).toBe("new1");
  });

  it("counts an already-offered topic as spent, not as runway", () => {
    // This is what froze the pipeline: 41 offered-but-unactioned topics read as
    // a full pool, so the seeder never ran and the rotation cursor never moved.
    const pool = Array.from({ length: 41 }, (_, i) => offered(String(i)));
    expect(needsTopUp(pool, 10)).toBe(true);
  });

});

describe("spreading a night across niches", () => {
  const inNiche = (id: string, niche: string | null): PendingTopic => ({
    id, query: `q-${id}`, source: "seeded", niche,
  });
  /** Deterministic but non-constant, so a lopsided draw would show up. */
  const lcg = (seed = 7) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  it("takes one topic from every niche before taking a second from any", () => {
    // The bug: one seed writes ten sibling titles for a single subniche, and a
    // uniform draw from a pool dominated by the latest seed put three of them
    // in one digest — three takes on "move fans to Telegram" in one night.
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => inNiche(`a${i}`, "Creator")),
      inNiche("b0", "Web3"),
      inNiche("c0", "iGaming"),
      inNiche("d0", "Media buying"),
    ];
    for (let seed = 1; seed <= 25; seed++) {
      const niches = selectTopics(pool, 4, lcg(seed)).map((t) => t.niche);
      expect(new Set(niches).size).toBe(4);
    }
  });

  it("keeps the counts per niche within one of each other", () => {
    const pool = ["A", "B", "C"].flatMap((n) =>
      Array.from({ length: 10 }, (_, i) => inNiche(`${n}${i}`, n))
    );
    const counts: Record<string, number> = {};
    for (const t of selectTopics(pool, 8, lcg())) counts[t.niche!] = (counts[t.niche!] ?? 0) + 1;
    expect(Object.values(counts).sort()).toEqual([2, 3, 3]);
  });

  it("goes back to a niche for more once the others are exhausted", () => {
    const pool = [inNiche("a0", "A"), inNiche("a1", "A"), inNiche("a2", "A"), inNiche("b0", "B")];
    expect(selectTopics(pool, 4, lcg())).toHaveLength(4);
  });

  it("treats topics with no niche as one group of their own", () => {
    // Hand-entered and legacy rows: they must neither crowd out the niches nor
    // be starved by them.
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => inNiche(`n${i}`, null)),
      inNiche("a0", "A"),
      inNiche("b0", "B"),
    ];
    const picked = selectTopics(pool, 3, lcg());
    expect(new Set(picked.map((t) => t.niche ?? "none")).size).toBe(3);
  });

  it("does not always lead with the same niche", () => {
    // Which niche gets the odd extra slot must rotate, or the first niche in
    // the pool is quietly favoured every night.
    const pool = ["A", "B", "C"].flatMap((n) =>
      Array.from({ length: 5 }, (_, i) => inNiche(`${n}${i}`, n))
    );
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) firsts.add(selectTopics(pool, 1, lcg(seed))[0].niche!);
    expect(firsts.size).toBe(3);
  });

  it("spreads unoffered topics first, and only then falls back to offered ones", () => {
    const pool = [
      inNiche("new-a", "A"),
      { ...inNiche("old-b", "B"), proposedTitle: "x" },
      { ...inNiche("old-c", "C"), proposedTitle: "y" },
    ];
    const picked = selectTopics(pool, 2, lcg());
    expect(picked[0].id).toBe("new-a");
    expect(picked).toHaveLength(2);
  });
});

describe("poolTarget", () => {
  it("keeps the pool at least two of the largest nights deep", () => {
    // A pool only as deep as one night holds two or three seeds' worth, so a
    // night drawn from it covers two or three niches however it is dealt.
    // Simulated over 600 nights at 4 topics per seed: a pool of 10 gave ~4
    // niches a night with up to 4 articles from one subniche; a pool of 20 gave
    // ~7 niches with never more than 2.
    expect(poolTarget(10, 10)).toBe(20);
  });

  it("respects a configured threshold that is already deeper", () => {
    expect(poolTarget(50, 10)).toBe(50);
  });

  it("follows maxPerNight when the operator raises it", () => {
    expect(poolTarget(10, 20)).toBe(40);
  });
});
