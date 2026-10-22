import { describe, it, expect } from "vitest";
process.env.ANTHROPIC_API_KEY ??= "test";
const { parseResearchBrief, renderResearchBrief, researchSystemPrompt } = await import("./research.js");

const sheet = {
  facts: [
    { claim: "Telegram channels show admins only the 200 most recent subscribers", source_url: "https://telegram.org/faq" },
    { claim: "No source here", source_url: "not a url" },
  ],
  tools: [
    {
      name: "Acme",
      url: "https://acme.example/",
      job: "Booking",
      difference: "Books against the live calendar",
      pricing: "$29/month",
      pricing_url: "https://acme.example/pricing",
      limitation: "No Telegram bot",
      telegram: null,
    },
    { name: "NoPricePage", url: "https://np.example/", job: "x", difference: "y", pricing: "$5", limitation: "z" },
  ],
  unverified: ["Acme's user count"],
};

describe("parseResearchBrief", () => {
  it("reads the fenced JSON and drops facts without a usable source", () => {
    const brief = parseResearchBrief("Done.\n```json\n" + JSON.stringify(sheet) + "\n```")!;
    expect(brief.facts).toHaveLength(1);
    expect(brief.tools).toHaveLength(2);
    expect(brief.unverified).toEqual(["Acme's user count"]);
  });

  it("drops a price that has no pricing page to link", () => {
    const brief = parseResearchBrief(JSON.stringify(sheet))!;
    expect(brief.tools.find((t) => t.name === "NoPricePage")!.pricing).toBeNull();
  });

  it("returns null for missing or empty output", () => {
    expect(parseResearchBrief("I could not find anything.")).toBeNull();
    expect(parseResearchBrief('```json\n{"facts":[],"tools":[]}\n```')).toBeNull();
  });
});

describe("renderResearchBrief", () => {
  it("puts the source next to every price and fact, and marks the unverified", () => {
    const out = renderResearchBrief(parseResearchBrief(JSON.stringify(sheet))!);
    expect(out).toContain("starting price: $29/month [source: https://acme.example/pricing]");
    expect(out).toContain("price: not published");
    expect(out).toContain("[source: https://telegram.org/faq]");
    expect(out).toMatch(/do NOT state these as fact[\s\S]*user count/);
  });
});

describe("researchSystemPrompt", () => {
  it("asks for a shortlist only at full depth, and always for primary sources", () => {
    expect(researchSystemPrompt("full", "2026-10-22")).toMatch(/shortlist of 6-10/);
    expect(researchSystemPrompt("light", "2026-10-22")).toMatch(/Leave "tools" empty/);
    for (const d of ["full", "light"] as const) {
      expect(researchSystemPrompt(d, "2026-10-22")).toMatch(/last 12 months/);
      expect(researchSystemPrompt(d, "2026-10-22")).toMatch(/do not research crmchat/);
    }
  });
});

describe("researchDepthFor", async () => {
  const { researchDepthFor } = await import("./generator.js");
  it.each([
    ["Best booking software for salons that sell through Telegram", "full"],
    ["Kommo vs crmchat for Telegram sales teams", "full"],
    ["Which tools do audit firms use for deal flow", "full"],
    ["How to warm up a new Telegram account before outreach", "light"],
    ["What is a VIP signal group", "light"],
  ])("%s → %s", (topic, depth) => {
    expect(researchDepthFor(topic)).toBe(depth);
  });
});
