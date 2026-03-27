import { describe, it, expect } from "vitest";
import { positionWeight, calculateOpportunityScore } from "./scoring.js";

describe("positionWeight", () => {
  it("returns 0.1 for positions 1-3 (already winning)", () => {
    expect(positionWeight(1)).toBe(0.1);
    expect(positionWeight(2)).toBe(0.1);
    expect(positionWeight(3)).toBe(0.1);
  });

  it("returns 0.5 for positions 4-10 (page 1, medium opportunity)", () => {
    expect(positionWeight(4)).toBe(0.5);
    expect(positionWeight(7)).toBe(0.5);
    expect(positionWeight(10)).toBe(0.5);
  });

  it("returns 1.0 for positions 11-30 (sweet spot, highest opportunity)", () => {
    expect(positionWeight(11)).toBe(1.0);
    expect(positionWeight(20)).toBe(1.0);
    expect(positionWeight(30)).toBe(1.0);
  });

  it("returns 0.3 for positions 31+ (too far back)", () => {
    expect(positionWeight(31)).toBe(0.3);
    expect(positionWeight(50)).toBe(0.3);
    expect(positionWeight(100)).toBe(0.3);
  });

  it("clamps position 0 to 1 (returns 0.1)", () => {
    expect(positionWeight(0)).toBe(0.1);
  });

  it("clamps negative positions to 1 (returns 0.1)", () => {
    expect(positionWeight(-5)).toBe(0.1);
  });
});

describe("calculateOpportunityScore", () => {
  it("scores position 12 higher than position 3 for similar keywords", () => {
    const pos3 = calculateOpportunityScore({
      impressions: 1000,
      ctr: 0.05,
      position: 3,
    });
    const pos12 = calculateOpportunityScore({
      impressions: 800,
      ctr: 0.01,
      position: 12,
    });

    // Position 12 should score higher (underserved sweet spot)
    expect(pos12).toBeGreaterThan(pos3);
  });

  it("returns 0 for 0 impressions", () => {
    expect(
      calculateOpportunityScore({ impressions: 0, ctr: 0.5, position: 10 })
    ).toBe(0);
  });

  it("clamps CTR > 1.0 to 1.0", () => {
    const score = calculateOpportunityScore({
      impressions: 100,
      ctr: 1.5,
      position: 10,
    });
    // With ctr clamped to 1.0: 100 * (1-1) * 0.5 = 0
    expect(score).toBe(0);
  });

  it("clamps negative CTR to 0", () => {
    const score = calculateOpportunityScore({
      impressions: 100,
      ctr: -0.5,
      position: 10,
    });
    // With ctr clamped to 0: 100 * 1 * 0.5 = 50
    expect(score).toBe(50);
  });

  it("handles the example from the design review", () => {
    // "telegram crm" at position 3: 1000 * 0.95 * 0.1 = 95
    const telegramCrm = calculateOpportunityScore({
      impressions: 1000,
      ctr: 0.05,
      position: 3,
    });
    expect(telegramCrm).toBeCloseTo(95, 0);

    // "whatsapp sales bot" at position 12: 800 * 0.99 * 1.0 = 792
    const whatsappSales = calculateOpportunityScore({
      impressions: 800,
      ctr: 0.01,
      position: 12,
    });
    expect(whatsappSales).toBeCloseTo(792, 0);

    // "telegram lead gen" at position 45: 500 * 0.995 * 0.3 = 149.25
    const telegramLead = calculateOpportunityScore({
      impressions: 500,
      ctr: 0.005,
      position: 45,
    });
    expect(telegramLead).toBeCloseTo(149.25, 0);
  });
});
