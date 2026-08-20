import { describe, it, expect } from "vitest";
import { sharesKeyword, contentWords } from "./title.js";

/**
 * Gate 1's proposeTitle prompt dropped half of the generator's TITLE CRAFT
 * rule 1 — "the target keyword MUST appear (Google still ranks on it)" — and
 * kept only "reframe it". Titles drifted until the topic was unrecognisable:
 *
 *   "How to research startup founders before a VC intro call"
 *     → "You Get 15 Minutes With a Founder. Don't Waste It Not Knowing Their Cap Table."
 *
 * These are the real proposals from a live digest.
 */
describe("contentWords", () => {
  it("drops stopwords and short filler", () => {
    expect(contentWords("How to research startup founders before a VC intro call")).toEqual(
      ["research", "startup", "founders", "intro", "call"]
    );
  });

  it("lowercases and strips punctuation", () => {
    expect(contentWords("Term Sheet, Signed!")).toEqual(["term", "sheet", "signed"]);
  });
});

describe("sharesKeyword", () => {
  const drifted: Array<[string, string]> = [
    // 0 of 5 topic words survive.
    ["How to research startup founders before a VC intro call",
     "You Get 15 Minutes With a Founder. Don't Waste It Not Knowing Their Cap Table."],
    // 1 of 7 survives ("fund"); "deals" does not match "deal" — the check is
    // exact-match, so plurals slip. Documented, not accidental: a stemmer would
    // let thinner overlaps through, and two exact words is a deliberately blunt
    // bar.
    ["How to build a crypto fund deal flow pipeline on Telegram",
     "Your Fund Sourced 60 Deals This Month. Half Are Buried in Someone's Personal Chat."],
  ];

  it.each(drifted)("rejects a title that lost the keyword: %s", (topic, title) => {
    expect(sharesKeyword(title, topic)).toBe(false);
  });

  it("accepts a title sitting exactly on the two-word bar", () => {
    // "community" + "founder" survive, but "vet", "Telegram", "Web3" and
    // "investing" do not. This PASSES at threshold 2 — the boundary case, kept
    // here so raising the bar is a deliberate edit with a visible consequence.
    expect(
      sharesKeyword(
        "That 40,000-Member Community Is 39,000 Bots and a Founder Who Never Shows Up",
        "How to vet a Web3 founder's Telegram community before investing"
      )
    ).toBe(true);
  });

  it("accepts a reframe that keeps the keyword", () => {
    // The generator's own worked example.
    expect(
      sharesKeyword(
        "Connect Vtiger to Telegram Without Breaking Your Pipeline",
        "Vtiger CRM Telegram integration setup guide"
      )
    ).toBe(true);
  });

  it("accepts a reframe carrying the substantive terms", () => {
    expect(
      sharesKeyword(
        "Your Term Sheet Stages Live in Three Different Chats",
        "How to track term sheet stages for crypto deals"
      )
    ).toBe(true);
  });

  it("does not accept a single incidental word as overlap", () => {
    expect(sharesKeyword("Founders Are Busy People", "How to research startup founders before a VC intro call")).toBe(false);
  });

  it("tolerates a short topic with only one content word", () => {
    expect(sharesKeyword("What Spintax Actually Buys You", "Spintax")).toBe(true);
  });
});
