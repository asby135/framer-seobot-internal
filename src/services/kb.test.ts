import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKB, searchKB, getKBArticleCount } from "./kb.js";

describe("Knowledge Base", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "kb-test-"));
    writeFileSync(
      join(testDir, "telegram-outreach.md"),
      `# Telegram Outreach Guide
How to run effective outreach campaigns on Telegram using CRMChat.
Set up your prospect database, warm up accounts, and launch sequences.
Outreach campaigns telegram sales automation CRM pipeline.`
    );
    writeFileSync(
      join(testDir, "pricing.md"),
      `# CRMChat Pricing
CRMChat offers three plans: Starter at $29/mo, Growth at $79/mo, and Enterprise custom pricing.
All plans include Telegram integration and pipeline management.`
    );
    writeFileSync(
      join(testDir, "ai-sales-agent.md"),
      `# Telegram AI Sales Agent
The AI sales agent automatically responds to leads in Telegram.
Configure response templates, set up triggers, and train the AI on your product.
Sales automation chatbot lead qualification.`
    );
    loadKB(testDir);
  });

  it("loads all .md files from directory", () => {
    expect(getKBArticleCount()).toBe(3);
  });

  it("returns relevant articles for telegram outreach query", () => {
    const results = searchKB("telegram outreach campaigns");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe("telegram-outreach.md");
  });

  it("returns pricing article for pricing query", () => {
    const results = searchKB("crmchat pricing plans cost");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe("pricing.md");
  });

  it("returns AI sales article for AI query", () => {
    const results = searchKB("ai sales agent chatbot");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe("ai-sales-agent.md");
  });

  it("respects topK limit", () => {
    const results = searchKB("telegram", 1);
    expect(results.length).toBe(1);
  });

  it("returns empty array for completely unrelated query", () => {
    const results = searchKB("quantum physics black holes");
    expect(results.length).toBe(0);
  });

  it("extracts title from markdown heading", () => {
    const results = searchKB("telegram outreach");
    expect(results[0].title).toBe("Telegram Outreach Guide");
  });
});
