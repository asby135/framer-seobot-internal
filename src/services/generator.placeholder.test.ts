import { describe, it, expect } from "vitest";
import { stripTrailingPlaceholder } from "./generator.js";

/**
 * 6 of 308 published articles carried a literal "placeholder" text node, 5 of
 * them trailing. No code emits it — it is model output that survived
 * sanitisation and shipped to the live site.
 */
describe("stripTrailingPlaceholder", () => {
  it("removes a bare trailing placeholder text node", () => {
    expect(stripTrailingPlaceholder("<p>Real body.</p>\n\nplaceholder")).toBe("<p>Real body.</p>");
  });

  it("removes a trailing placeholder wrapped in a paragraph", () => {
    expect(stripTrailingPlaceholder("<p>Real body.</p><p>placeholder</p>")).toBe("<p>Real body.</p>");
  });

  it("is case-insensitive", () => {
    expect(stripTrailingPlaceholder("<p>Body</p>\nPlaceholder")).toBe("<p>Body</p>");
  });

  it("tolerates surrounding whitespace", () => {
    expect(stripTrailingPlaceholder("<p>Body</p>\n\n   placeholder   \n")).toBe("<p>Body</p>");
  });

  it("leaves the word alone when it appears mid-content", () => {
    // "placeholder" is a legitimate word in a CRM article about form fields.
    const html = "<p>Set the placeholder text on your form.</p><p>Then save.</p>";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("leaves a trailing paragraph that merely contains the word", () => {
    const html = "<p>Body</p><p>Use a placeholder value here.</p>";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("returns unchanged content when there is no placeholder", () => {
    expect(stripTrailingPlaceholder("<p>Clean article.</p>")).toBe("<p>Clean article.</p>");
  });

  it("handles an empty string", () => {
    expect(stripTrailingPlaceholder("")).toBe("");
  });

  it("removes only one trailing placeholder, not real trailing content", () => {
    expect(stripTrailingPlaceholder("<p>A</p><p>B</p>placeholder")).toBe("<p>A</p><p>B</p>");
  });
});

describe("stripTrailingPlaceholder — no-op safety", () => {
  it("leaves trailing whitespace alone when there is no placeholder", () => {
    // The function must not rewrite content it did not need to change.
    const html = "<p>Body</p>\n\n";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("returns the identical string reference when nothing matches", () => {
    const html = "<p>Clean</p>";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("still trims whitespace left behind after removing a placeholder", () => {
    expect(stripTrailingPlaceholder("<p>Body</p>\n\nplaceholder\n")).toBe("<p>Body</p>");
  });
});

describe("stripTrailingPlaceholder — must not truncate real prose", () => {
  // Found in code review, verified against the shipped regex:
  //   "<p>The final field is a placeholder</p>" -> "<p>The final field is a"
  // It ran on EVERY generated article via sanitizeHTML, corrupting text and
  // leaving unbalanced HTML. Worse than the artifact it was written to remove.
  it("leaves a sentence ending in the word intact", () => {
    const html = "<p>The final field is a placeholder</p>";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("leaves a final paragraph ending in the word intact", () => {
    const html = "<p>Body</p><p>Use a placeholder</p>";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("leaves 'Set the placeholder' intact", () => {
    const html = "<p>Set the placeholder</p>";
    expect(stripTrailingPlaceholder(html)).toBe(html);
  });

  it("never produces unbalanced HTML", () => {
    const html = "<p>The final field is a placeholder</p>";
    const out = stripTrailingPlaceholder(html);
    const opens = (out.match(/<p[^>]*>/g) ?? []).length;
    const closes = (out.match(/<\/p>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("still removes a paragraph whose ENTIRE content is the word", () => {
    expect(stripTrailingPlaceholder("<p>Body</p><p>placeholder</p>")).toBe("<p>Body</p>");
  });

  it("still removes a bare trailing text node", () => {
    expect(stripTrailingPlaceholder("<p>Body</p>\n\nplaceholder")).toBe("<p>Body</p>");
  });
});
