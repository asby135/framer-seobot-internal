import { describe, it, expect } from "vitest";
import { nextSlot, countSlots, DEFAULT_NICHES, ANGLES, type Niche } from "./taxonomy.js";

const niches: Niche[] = [
  { name: "A", persona: "pa", subniches: ["a1", "a2"], kb_hints: [], probation: false },
  { name: "B", persona: "pb", subniches: ["b1"], kb_hints: [], probation: false },
];

describe("countSlots", () => {
  it("multiplies subniches by angles across every niche", () => {
    expect(countSlots(niches)).toBe(3 * ANGLES.length);
  });

  it("ignores niches with no subniches", () => {
    expect(countSlots([...niches, { name: "C", persona: "p", subniches: [], kb_hints: [], probation: false }]))
      .toBe(3 * ANGLES.length);
  });
});

describe("nextSlot", () => {
  it("returns the first slot at cursor 0", () => {
    expect(nextSlot(niches, 0)).toEqual({
      niche: niches[0],
      subniche: "a1",
      angle: ANGLES[0],
      cursor: 1,
    });
  });

  it("advances through angles before moving subniche", () => {
    const s = nextSlot(niches, 1)!;
    expect(s.angle).toBe(ANGLES[1]);
    expect(s.subniche).toBe("a1");
  });

  it("moves to the next subniche once angles are exhausted", () => {
    const s = nextSlot(niches, ANGLES.length)!;
    expect(s.subniche).toBe("a2");
    expect(s.angle).toBe(ANGLES[0]);
  });

  it("moves to the next niche once its subniches are exhausted", () => {
    expect(nextSlot(niches, ANGLES.length * 2)!.niche.name).toBe("B");
  });

  it("wraps around to the start but keeps the cursor monotonic", () => {
    const total = countSlots(niches);
    const s = nextSlot(niches, total)!;
    expect(s.niche.name).toBe("A");
    expect(s.subniche).toBe("a1");
    expect(s.cursor).toBe(total + 1);
  });

  it("skips niches on probation", () => {
    const withProbation: Niche[] = [{ ...niches[0], probation: true }, niches[1]];
    expect(nextSlot(withProbation, 0)!.niche.name).toBe("B");
  });

  it("returns null when every niche is on probation", () => {
    expect(nextSlot(niches.map((n) => ({ ...n, probation: true })), 0)).toBeNull();
  });

  it("returns null when there are no niches at all", () => {
    expect(nextSlot([], 0)).toBeNull();
  });

  it("handles a negative cursor without throwing", () => {
    expect(nextSlot(niches, -1)).not.toBeNull();
  });

  it("visits every slot exactly once across a full cycle", () => {
    const total = countSlots(niches);
    const seen = new Set<string>();
    for (let c = 0; c < total; c++) {
      const s = nextSlot(niches, c)!;
      seen.add(`${s.niche.name}|${s.subniche}|${s.angle}`);
    }
    expect(seen.size).toBe(total);
  });
});

describe("DEFAULT_NICHES", () => {
  it("ships the 8 agreed niches", () => {
    expect(DEFAULT_NICHES).toHaveLength(8);
  });

  it("puts the 3 thin-KB niches on probation", () => {
    const probation = DEFAULT_NICHES.filter((n) => n.probation).map((n) => n.name);
    expect(probation).toHaveLength(3);
    expect(probation.join(" ")).toMatch(/RU B2B SaaS/);
    expect(probation.join(" ")).toMatch(/RU AI/);
    expect(probation.join(" ")).toMatch(/currency exchanges/i);
  });

  it("gives every niche a persona SENTENCE, not a bare label", () => {
    // seedTopics grounds on searchKB(audience) — a one-word label retrieves noise.
    for (const n of DEFAULT_NICHES) {
      expect(n.persona.split(/\s+/).length).toBeGreaterThan(6);
    }
  });

  it("gives every niche subniches to rotate through", () => {
    for (const n of DEFAULT_NICHES) {
      expect(n.subniches.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("provides ~6 months of runway while 3 niches are still on probation", () => {
    // countSlots counts only ROTATABLE niches, so probation shrinks the live
    // space: 5 niches × 6 subniches × 5 angles = 150 slots = ~1,500 topics,
    // roughly 200 nights at 7.5 articles/night.
    const topics = countSlots(DEFAULT_NICHES) * 10;
    expect(topics).toBeGreaterThan(1000);
  });

  it("reaches a year of runway once probation is cleared", () => {
    const cleared = DEFAULT_NICHES.map((n) => ({ ...n, probation: false }));
    expect(countSlots(cleared) * 10).toBeGreaterThan(2000);
  });
});
