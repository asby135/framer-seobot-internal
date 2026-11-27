import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { kbExcerpt, KB_EXCERPT_CHARS, loadKB, searchKB, getKBArticle, fullKBContext } from "./kb.js";

/**
 * How much of a knowledge-base page reaches the model.
 *
 * Every page was cut at 2,000 characters — 49 of 63 pages are longer. pricing.md
 * stopped mid-table at "| 13-15 accounts | $2", so the writer was told never to
 * invent pricing while being shown a truncated price list, and the fact-checker
 * flagged correct claims about the tiers it could not see.
 */
describe("kbExcerpt", () => {
  it("passes the whole pricing page", () => {
    const pricing = readFileSync("knowledge/pricing.md", "utf-8");
    expect(kbExcerpt(pricing)).toBe(pricing);
  });

  it("still bounds a very long page, and says it was cut", () => {
    const long = "x".repeat(KB_EXCERPT_CHARS + 500);
    const out = kbExcerpt(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/truncated/i);
  });
});

describe("legal pages", () => {
  it("are never returned by search, however the query is worded", () => {
    loadKB("knowledge");
    for (const q of [
      "media buying providers finding and closing media buyers through Telegram communities",
      "how CRMChat handles client data and privacy",
    ]) {
      const files = searchKB(q, 10).map((r) => r.filename);
      expect(files).not.toContain("privacy-policy.md");
      expect(files).not.toContain("data-handling-policy.md");
    }
  });

  it("are still reachable by name", () => {
    loadKB("knowledge");
    expect(getKBArticle("privacy-policy.md")).toBeDefined();
  });
});

describe("search on common words", () => {
  it("still finds pages when every query word is common", () => {
    // "telegram outreach" is a core head term; with both words on most pages it
    // used to return nothing at all.
    loadKB("knowledge");
    expect(searchKB("telegram outreach", 4).length).toBeGreaterThan(0);
  });

  it("folds parse / parser / parsing together", () => {
    loadKB("knowledge");
    const files = searchKB("how to parse telegram groups", 4).map((r) => r.filename);
    expect(files).toContain("telegram-group-parser.md");
  });
});

describe("fullKBContext", () => {
  it("holds every doc, in a fixed order, so the cached prefix never changes between calls", () => {
    loadKB("knowledge");
    const a = fullKBContext();
    const files = readdirSync("knowledge").filter((f) => f.endsWith(".md")).sort();
    for (const f of files) expect(a).toContain(`--- KB doc: ${f} (`);
    expect(a.indexOf(`--- KB doc: ${files[0]} (`)).toBe(0);
    loadKB("knowledge");
    expect(fullKBContext()).toBe(a);
  });

  it("includes the pricing page whole, whatever the topic", () => {
    loadKB("knowledge");
    expect(fullKBContext()).toContain(readFileSync("knowledge/pricing.md", "utf-8").trim());
  });
});
