import { describe, it, expect } from "vitest";
import { selectTopics, needsTopUp, usableTopics, type PendingTopic } from "./selection.js";

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
