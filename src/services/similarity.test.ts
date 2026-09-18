import { describe, it, expect } from "vitest";
import { titleSimilarity, findNearDuplicate, NEAR_DUPLICATE_THRESHOLD } from "./similarity.js";

describe("titleSimilarity", () => {
  it("scores a reworded version of the same task above the threshold", () => {
    const s = titleSimilarity(
      "How to Export Telegram Group Members to CSV",
      "How to Export Members From a Telegram Group to a CSV File"
    );
    expect(s).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  it("ignores the title shape, so a what-is and a how-to on one subject still match", () => {
    const s = titleSimilarity(
      "What Is Telegram Account Warmup Explained",
      "Telegram Account Warmup: How It Works"
    );
    expect(s).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  it("treats singular and plural as the same word", () => {
    expect(titleSimilarity("Fix Blocked Telegram Bot Links", "Fix a Blocked Telegram Bot Link")).toBe(1);
  });

  it("keeps sibling tasks in one subniche apart", () => {
    // Both real, both published, and genuinely different articles. The closest
    // legitimate pair in the corpus scored 0.44 when the threshold was chosen.
    const s = titleSimilarity(
      "How to Price a Custom ML Model Development Project for a Client",
      "How to Price a Chatbot Development Project for a Small Business Client"
    );
    expect(s).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it("does not let 'Telegram' alone make two titles look alike", () => {
    // Nearly every title on the blog contains it, so it carries no signal.
    const s = titleSimilarity("How to Set Up a Telegram Bot", "How to Set Up a Telegram Channel");
    expect(s).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it("scores titles with no meaningful words as unrelated rather than identical", () => {
    expect(titleSimilarity("How to", "What Is")).toBe(0);
  });
});

describe("findNearDuplicate", () => {
  const corpus = [
    "Why Telegram Accounts Get Banned for Bulk Messaging",
    "How to Export Telegram Group Members to CSV",
  ];

  it("returns the existing title a candidate is too close to", () => {
    expect(findNearDuplicate("How to Export Members of a Telegram Group to CSV", corpus)).toBe(corpus[1]);
  });

  it("returns undefined for new ground", () => {
    expect(findNearDuplicate("How to Rotate Chatter Shifts Around the Clock", corpus)).toBeUndefined();
  });
});
