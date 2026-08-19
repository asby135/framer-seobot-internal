import { describe, it, expect } from "vitest";
import { buildSeederPrompt, MAX_COVERED, type SeederPromptInput } from "./seeder.js";

const base: SeederPromptInput = {
  audience: "Web3 BD leads at DeFi protocols",
  subniche: "crypto funds and VCs",
  angle: "migration",
  kbContext: "KB text here",
  covered: ["existing topic one", "existing topic two"],
  count: 10,
};

describe("buildSeederPrompt", () => {
  it("states the angle as a constraint on every topic", () => {
    const p = buildSeederPrompt(base);
    expect(p).toContain("migration");
    expect(p).toMatch(/every topic must take this angle/i);
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
