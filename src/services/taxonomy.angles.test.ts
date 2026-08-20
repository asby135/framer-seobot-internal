import { describe, it, expect } from "vitest";
import {
  ANGLE_WEIGHTS,
  ANGLE_SCHEDULE,
  buildAngleSchedule,
  ANGLES,
  ANGLE_GUIDANCE,
  nextSlot,
  countPairs,
  DEFAULT_NICHES,
} from "./taxonomy.js";

/**
 * The article-type distribution the generator's ARTICLE TYPE rules are built
 * for: 67% how-to, 13% what-is, 4% comparison, 1% tops, the rest
 * troubleshooting/FAQ.
 *
 * The generator classifies each keyword into one of five archetypes and gives
 * it that archetype's structure and length. But nothing produced the intended
 * MIX — the angle rotation treated all angles equally, so ~20% of topics came
 * out as comparisons against a 4% target, and no what-is topics existed at all.
 */
describe("ANGLE_WEIGHTS", () => {
  it("matches the target distribution", () => {
    expect(ANGLE_WEIGHTS).toEqual({
      "how-to": 67,
      "what-is": 13,
      troubleshooting: 15,
      comparison: 4,
      tops: 1,
    });
  });

  it("sums to 100 so the weights read as percentages", () => {
    expect(Object.values(ANGLE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("covers exactly the five generator archetypes", () => {
    expect([...ANGLES].sort()).toEqual(
      ["comparison", "how-to", "tops", "troubleshooting", "what-is"].sort()
    );
  });

  it("gives every angle prompt guidance, since the bare word is ambiguous", () => {
    // "tops" alone would not tell the seeder to produce "best X tools" topics.
    for (const angle of ANGLES) {
      expect(ANGLE_GUIDANCE[angle]).toBeTruthy();
      expect(ANGLE_GUIDANCE[angle].length).toBeGreaterThan(20);
    }
  });
});

describe("buildAngleSchedule", () => {
  it("emits each angle exactly its weight in counts", () => {
    const schedule = buildAngleSchedule(ANGLE_WEIGHTS);
    const counts: Record<string, number> = {};
    for (const a of schedule) counts[a] = (counts[a] ?? 0) + 1;
    expect(counts).toEqual(ANGLE_WEIGHTS);
  });

  it("has one entry per weight unit", () => {
    expect(buildAngleSchedule(ANGLE_WEIGHTS)).toHaveLength(100);
  });

  it("interleaves rather than blocking — no long run of one angle", () => {
    // A naive schedule would emit 67 how-tos, then 15 troubleshooting, etc.
    // That would mean months of nothing but how-to before any variety.
    const schedule = buildAngleSchedule(ANGLE_WEIGHTS);
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < schedule.length; i++) {
      run = schedule[i] === schedule[i - 1] ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeLessThanOrEqual(6);
  });

  it("places the rarest angle somewhere, not never", () => {
    expect(buildAngleSchedule(ANGLE_WEIGHTS)).toContain("tops");
  });

  it("is deterministic", () => {
    expect(buildAngleSchedule(ANGLE_WEIGHTS)).toEqual(buildAngleSchedule(ANGLE_WEIGHTS));
  });

  it("handles a single-angle weighting", () => {
    expect(buildAngleSchedule({ "how-to": 3 })).toEqual(["how-to", "how-to", "how-to"]);
  });
});

describe("ANGLE_SCHEDULE", () => {
  it("delivers roughly the target share over a realistic run", () => {
    // 200 nights of seeding.
    const counts: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const a = ANGLE_SCHEDULE[i % ANGLE_SCHEDULE.length];
      counts[a] = (counts[a] ?? 0) + 1;
    }
    expect(counts["how-to"] / 200).toBeCloseTo(0.67, 1);
    expect(counts["what-is"] / 200).toBeCloseTo(0.13, 1);
    expect(counts["comparison"] / 200).toBeCloseTo(0.04, 1);
  });
});

describe("angle coverage per subniche (regression)", () => {
  // Found in review. Indexing the angle on the raw cursor coupled it to the
  // pair index through gcd(pairs, schedule). At the real 48 pairs vs 100 slots
  // that gcd is 4, so 36 of 48 subniches NEVER received a "tops" topic and 24
  // never received a "comparison" — while every aggregate test stayed green,
  // because the GLOBAL mix was correct the whole time.
  it("every (niche, subniche) pair reaches every angle over a full cycle", () => {
    const pairs = countPairs(DEFAULT_NICHES);
    const cycle = pairs * ANGLE_SCHEDULE.length;
    const seen = new Map<string, Set<string>>();

    for (let c = 0; c < cycle; c++) {
      const s = nextSlot(DEFAULT_NICHES, c)!;
      const key = `${s.niche.name}|${s.subniche}`;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(s.angle);
    }

    const starved = [...seen.entries()].filter(([, a]) => a.size < ANGLES.length);
    expect(starved.map(([k]) => k)).toEqual([]);
    expect(seen.size).toBe(pairs);
  });

  it("keeps the global mix at the configured weights", () => {
    const pairs = countPairs(DEFAULT_NICHES);
    const cycle = pairs * ANGLE_SCHEDULE.length;
    const counts: Record<string, number> = {};
    for (let c = 0; c < cycle; c++) {
      const a = nextSlot(DEFAULT_NICHES, c)!.angle;
      counts[a] = (counts[a] ?? 0) + 1;
    }
    for (const [angle, weight] of Object.entries(ANGLE_WEIGHTS)) {
      expect(Math.round((counts[angle] / cycle) * 100)).toBe(weight);
    }
  });

  it("does not clump one angle into a long consecutive run", () => {
    let longest = 1, run = 1, prev = "";
    for (let c = 0; c < 400; c++) {
      const a = nextSlot(DEFAULT_NICHES, c)!.angle;
      run = a === prev ? run + 1 : 1;
      prev = a;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(6);
  });
});
