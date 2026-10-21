import { describe, it, expect } from "vitest";
process.env.ANTHROPIC_API_KEY ??= "test";
const { GENERATOR_SYSTEM_PROMPT, buildTitleCleanupPrompt, editingInstructionsBlock } = await import("./generator.js");
const { TITLE_RULES } = await import("./title-rules.js");

/**
 * One title style. The house rules (title-rules.ts) say the title IS the
 * search query, stated plainly; the article prompt's TITLE CRAFT section and
 * the tic-cleanup prompt said the opposite — reframe the keyword, lead with
 * pain, vary the shape — so an unpinned title got two contradictory briefs.
 */
describe("the article prompt agrees with the house title rules", () => {
  it.each([
    "THE KEYWORD IS A SEED",
    "LEAD WITH PAIN, PAYOFF",
    "SHAPE VARIETY",
    "Treat it as copywriting",
    "TITLE CRAFT rule 5",
  ])("no longer says %s", (phrase) => {
    expect(GENERATOR_SYSTEM_PROMPT).not.toContain(phrase);
  });

  it("points the title at the TITLE RULES, naming the competitor-pricing exception", () => {
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/TITLE RULES/);
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/competitor[- ]pricing/i);
  });

  it("still carries the competitor-pricing reframe itself", () => {
    expect(GENERATOR_SYSTEM_PROMPT).toContain("Manychat vs crmchat: Real Pricing Breakdown");
  });
});

/**
 * The writing guide (Oct 2026). The prompt used to open every article with a
 * pain scene and put crmchat first; the guide wants the answer first, a
 * comparison table in listicles, and a source behind every number.
 */
describe("the article prompt follows the writing guide", () => {
  it("opens with key takeaways and an answer, not a pain scene", () => {
    expect(GENERATOR_SYSTEM_PROMPT).toContain("Key takeaways");
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/40-60 words answers the title/);
    expect(GENERATOR_SYSTEM_PROMPT).not.toMatch(/PAIN-DRIVEN OPENING|bad day/);
  });

  it("asks listicles for a comparison table and both fit and misfit per product", () => {
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/comparison table of every product/);
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/who it fits AND when it does not fit/);
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/without superlatives/);
  });

  it("requires a source for every number and bans em dashes", () => {
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/No source, no number/);
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/No em dashes/);
  });

  it("asks for 3-5 internal links with short anchors and a visible FAQ", () => {
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/link 3-5 related articles/);
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/2-5 words/);
    expect(GENERATOR_SYSTEM_PROMPT).toMatch(/<h2>FAQ<\/h2>/);
  });
});

describe("the tic-cleanup prompt", () => {
  const prompt = buildTitleCleanupPrompt("how to export telegram group members to csv");

  it("applies the house rules", () => {
    expect(prompt).toContain(TITLE_RULES);
  });

  it("no longer asks for a reframe or a hook", () => {
    expect(prompt).not.toMatch(/don't copy it verbatim|Lead with pain|surprising claim|Pick ONE shape/i);
  });
});

describe("editing instructions", () => {
  it("are their own labelled block, not part of the topic", () => {
    const block = editingInstructionsBlock("Remove the claim about 800M users");
    expect(block).toMatch(/EDITING INSTRUCTIONS/);
    expect(block).toContain("Remove the claim about 800M users");
    expect(block).toMatch(/do not invent/i);
  });

  it("are nothing when absent", () => {
    expect(editingInstructionsBlock(undefined)).toBe("");
    expect(editingInstructionsBlock("   ")).toBe("");
  });
});
