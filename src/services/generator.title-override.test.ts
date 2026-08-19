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

  it("falls back to the full craft rules when no title is pinned", () => {
    const out = buildTitleInstruction(undefined);
    expect(out).toContain("HARD BAN");
    expect(out).not.toMatch(/verbatim/i);
  });

  it("treats an empty string as no pinned title", () => {
    expect(buildTitleInstruction("")).toContain("HARD BAN");
  });

  it("escapes a quote in the approved title so the instruction stays parseable", () => {
    const out = buildTitleInstruction('The "Best" CRM');
    expect(out).toContain('The \\"Best\\" CRM');
  });
});
