import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";

/**
 * Comparison articles printed every competitor's price and "See the crmchat
 * site" for crmchat, because the pricing page was never retrieved for topics
 * like "Telebiz alternatives". It now rides along on every comparison.
 */

let withPricingForComparisons: typeof import("./generator.js").withPricingForComparisons;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY ??= "test";
  const kb = await import("./kb.js");
  kb.loadKB(join(process.cwd(), "knowledge"));
  ({ withPricingForComparisons } = await import("./generator.js"));
});

describe("withPricingForComparisons", () => {
  it("adds the pricing page to a comparison that did not retrieve it", () => {
    const out = withPricingForComparisons("Telebiz Alternatives for Automated Telegram Follow-Ups", [{ filename: "a.md" }]);
    expect(out.map((d) => d.filename)).toEqual(["a.md", "pricing.md"]);
  });

  it("does not add it twice", () => {
    const out = withPricingForComparisons("Best Telegram CRMs With a Shared Team Inbox", [{ filename: "pricing.md" }]);
    expect(out).toHaveLength(1);
  });

  it("leaves how-to articles alone", () => {
    const out = withPricingForComparisons("How to Warm Up a Telegram Account", [{ filename: "a.md" }]);
    expect(out.map((d) => d.filename)).toEqual(["a.md"]);
  });
});
