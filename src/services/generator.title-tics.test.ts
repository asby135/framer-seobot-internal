import { describe, it, expect } from "vitest";
import { findTitleTics } from "./generator.js";

describe("findTitleTics", () => {
  it("returns empty for clean titles", () => {
    expect(findTitleTics("Connect Vtiger to Telegram Without Breaking Your Pipeline")).toEqual([]);
    expect(findTitleTics("The Telegram Outreach Playbook iGaming Affiliates Use")).toEqual([]);
    expect(findTitleTics("Is Manychat Worth It for Telegram Outreach?")).toEqual([]);
  });

  it("catches 'Actually' (case-insensitive, word-boundary)", () => {
    expect(findTitleTics("What You Actually Get from Manychat")).toContain("actually");
    expect(findTitleTics("ACTUALLY converts on Telegram")).toContain("actually");
    // Substring shouldn't false-positive (no word like "factually" should match)
    expect(findTitleTics("Factually accurate guide")).not.toContain("actually");
  });

  it("catches parenthetical (Step-by-Step)", () => {
    expect(findTitleTics("How to Set Up Telegram Integration in Kommo (Step-by-Step)")).toContain("(step-by-step) parenthetical");
    expect(findTitleTics("Vtiger CRM Telegram Integration: Step-by-Step Setup Guide")).not.toContain("(step-by-step) parenthetical"); // no parens
    expect(findTitleTics("Setup (Step by Step)")).toContain("(step-by-step) parenthetical");
  });

  it("catches 'No-Fluff' and 'No-Agency'", () => {
    expect(findTitleTics("How to Run Telegram Ads by Myself: A No-Agency, No-Fluff Guide"))
      .toEqual(expect.arrayContaining(["no-fluff", "no-agency"]));
  });

  it("catches year suffixes", () => {
    expect(findTitleTics("Best Telegram CRMs in 2026")).toContain("year suffix");
    expect(findTitleTics("Top tools in 2025")).toContain("year suffix");
    expect(findTitleTics("Built in 2024")).toContain("year suffix");
    // Not a year-as-suffix-context
    expect(findTitleTics("Section 2024 of the guide")).not.toContain("year suffix"); // false: "in" missing
  });

  it("catches generic guide tics", () => {
    expect(findTitleTics("The Ultimate Telegram CRM Guide")).toContain("ultimate");
    expect(findTitleTics("Telegram CRMs: A Complete Guide")).toContain("complete guide");
    expect(findTitleTics("Telegram Outreach: A Deep Dive")).toContain("a deep dive");
    expect(findTitleTics("Telegram Bans: Everything You Need to Know")).toContain("everything you need");
    expect(findTitleTics("What You Need to Know About Telegram Bans")).toContain("what you need to know");
    expect(findTitleTics("The Truth About Telegram Outreach")).toContain("the truth about");
  });

  it("returns all violations in a single title", () => {
    const tics = findTitleTics("The Ultimate Telegram Guide: What You Actually Need to Know in 2026");
    expect(tics).toEqual(expect.arrayContaining(["ultimate", "actually", "year suffix"]));
  });
});
