import { describe, it, expect } from "vitest";
import { buildTitleInstruction } from "./generator.js";

describe("buildTitleInstruction", () => {
  it("pins an approved title verbatim", () => {
    const out = buildTitleInstruction("My Approved Headline");
    expect(out).toContain("My Approved Headline");
    expect(out).toMatch(/exact|verbatim/i);
  });

  it("tells the model to write the body to fit the approved headline", () => {
    expect(buildTitleInstruction("A Headline")).toMatch(/body/i);
  });

  it("does not repeat the ban-list when a title is already approved", () => {
    // The operator approved this exact string; restating the ban-list invites
    // the model to "improve" it, which would silently break the gate contract.
    expect(buildTitleInstruction("Ultimate Headline")).not.toContain("HARD BAN");
  });

  it("falls back to the shared house rules when no title is pinned", () => {
    // One source of truth: manual generation must not get a second, divergent
    // rule set — that divergence is what let titles drift off their keyword.
    const out = buildTitleInstruction(undefined);
    expect(out).toContain("TITLE RULES");
    expect(out).toMatch(/the title IS the search query/i);
    expect(out).not.toMatch(/verbatim/i);
  });

  it("treats an empty string as no pinned title", () => {
    expect(buildTitleInstruction("")).toContain("TITLE RULES");
  });

  it("escapes a quote in the approved title so the instruction stays parseable", () => {
    const out = buildTitleInstruction('The "Best" CRM');
    expect(out).toContain('The \\"Best\\" CRM');
  });
});
