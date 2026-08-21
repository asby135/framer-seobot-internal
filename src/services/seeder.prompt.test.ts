import { describe, it, expect } from "vitest";
import { buildSeederPrompt, buildSeederSystemPrompt, MAX_COVERED, type SeederPromptInput } from "./seeder.js";

const base: SeederPromptInput = {
  audience: "Web3 BD leads at DeFi protocols",
  subniche: "crypto funds and VCs",
  angle: "migration",
  kbContext: "KB text here",
  covered: ["existing topic one", "existing topic two"],
  count: 10,
};

describe("buildSeederPrompt", () => {
  it("states the article type as a constraint on every title", () => {
    const p = buildSeederPrompt(base);
    expect(p).toContain("migration");
    expect(p).toMatch(/every title must be this type/i);
  });

  it("carries the required title shape for the type", () => {
    // The angle word alone does not tell the model what the title should look
    // like: "what-is" has to become "What Is X", not a clever reframe.
    expect(buildSeederPrompt({ ...base, angle: "what-is" })).toMatch(/REQUIRED TITLE SHAPE/);
    expect(buildSeederPrompt({ ...base, angle: "what-is" })).toContain("What Is");
  });

  it("narrows to the subniche", () => {
    expect(buildSeederPrompt(base)).toContain("crypto funds and VCs");
  });

  it("includes the audience persona", () => {
    expect(buildSeederPrompt(base)).toContain("Web3 BD leads at DeFi protocols");
  });

  it("asks for the requested number of topics", () => {
    expect(buildSeederPrompt({ ...base, count: 7 })).toContain("7");
  });

  it("lists already-covered topics so Claude avoids near-duplicates", () => {
    const p = buildSeederPrompt(base);
    expect(p).toMatch(/already covered/i);
    expect(p).toContain("existing topic one");
    expect(p).toContain("existing topic two");
  });

  it("omits the covered block entirely when nothing is covered yet", () => {
    expect(buildSeederPrompt({ ...base, covered: [] })).not.toMatch(/already covered/i);
  });

  it("caps the covered list so the prompt cannot grow unbounded", () => {
    const many = Array.from({ length: 500 }, (_, i) => `topic-${i}`);
    const p = buildSeederPrompt({ ...base, covered: many });
    expect(p).toContain(`topic-${MAX_COVERED - 1}`);
    expect(p).not.toContain(`topic-${MAX_COVERED}`);
  });

  it("includes KB context when present", () => {
    expect(buildSeederPrompt(base)).toContain("KB text here");
  });

  it("falls back to a general-positioning note when no KB matched", () => {
    const p = buildSeederPrompt({ ...base, kbContext: "" });
    expect(p).toMatch(/no specific kb context/i);
  });
});

describe("buildSeederSystemPrompt", () => {
  it("states the audience is small teams, not enterprise", () => {
    const p = buildSeederSystemPrompt(10);
    expect(p).toMatch(/SMB SCALE/);
    expect(p).toMatch(/small sales teams/i);
  });

  it("names the upmarket framings that leaked through a subniche label", () => {
    // "enterprise GTM firms" produced a whole batch of "Enterprise Telegram
    // Outreach" / "Account-Based" / "Multi-Touch Sequence" titles aimed at a
    // reader CRMChat does not sell to.
    const p = buildSeederSystemPrompt(10);
    for (const tell of ["enterprise", "account-based", "multi-touch sequence"]) {
      expect(p.toLowerCase()).toContain(tell);
    }
  });

  it("says a market-segment subniche describes who the reader sells TO", () => {
    expect(buildSeederSystemPrompt(10)).toMatch(/never the size of the reader's own team/);
  });

  it("still forbids product-led topics", () => {
    expect(buildSeederSystemPrompt(10)).toMatch(/must NOT be about CRMChat/);
  });

  it("asks for the requested count", () => {
    expect(buildSeederSystemPrompt(7)).toContain("exactly 7 titles");
  });
});
