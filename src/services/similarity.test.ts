import { describe, it, expect } from "vitest";
import { titleSimilarity, findNearDuplicate, createTitleIndex, NEAR_DUPLICATE_THRESHOLD } from "./similarity.js";

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

describe("titleSimilarity — distinct tasks on one subject are not duplicates", () => {
  // Shape words are stripped so rewordings match, but some of them carry the
  // task. The rotation deliberately asks for a how-to AND a troubleshooting
  // article per subniche; the guard was refusing the second.
  it.each([
    ["Telegram Folder Sync Not Working", "How to Set Up Telegram Folder Sync"],
    ["How to Fix a Telegram Bot That Stopped Sending Messages", "How to Set Up a Telegram Bot to Send Messages"],
    ["How to Export Telegram Group Members to CSV", "How to Import Telegram Group Members from CSV"],
    ["How to Schedule Telegram Messages", "How to Cancel Scheduled Telegram Messages"],
    ["How to Add Members to a Telegram Group", "How to Remove Members from a Telegram Group"],
    ["Why Telegram Accounts Get Banned", "How to Recover a Banned Telegram Account"],
  ])("%s ≠ %s", (a, b) => {
    expect(titleSimilarity(a, b)).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it("still catches a rewording that shares the failure", () => {
    expect(
      titleSimilarity("Telegram Folder Sync Not Working", "Fix Telegram Folder Sync That Is Not Working")
    ).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  it("matches 'banned' with 'bans'", () => {
    // The stemmer left "bann" and "ban" apart, so this pair slipped through.
    expect(
      titleSimilarity(
        "Why Telegram Accounts Get Banned for Bulk Messaging",
        "How to Avoid Telegram Account Bans When Bulk Messaging"
      )
    ).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });
});

describe("titleSimilarity — the task distinctions are not loopholes", () => {
  it("treats 'Fix X' and 'Why X' about the same failure as the same ground", () => {
    expect(
      titleSimilarity("Fix a Telegram Account Banned for Bulk Messaging", "Why Telegram Accounts Get Banned for Bulk Messaging")
    ).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  it("treats synonym verbs on one side as the same task", () => {
    // delete/remove are both "reversal" words: having one each is not a
    // difference in task.
    expect(
      titleSimilarity("How to Delete Old Messages in a Telegram Group", "How to Remove Old Messages in a Telegram Group")
    ).toBeGreaterThanOrEqual(0.5);
  });
});

describe("neighbors", () => {
  it("offers different-task titles too — the model judge decides those", () => {
    const index = createTitleIndex(["Why Telegram Accounts Get Banned"]);
    expect(index.neighbors("How to Recover a Banned Telegram Account")).toEqual(["Why Telegram Accounts Get Banned"]);
  });
});
