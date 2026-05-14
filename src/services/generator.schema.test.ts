import { describe, it, expect } from "vitest";
import { isValidJsonLd } from "./generator.js";

describe("isValidJsonLd", () => {
  it("accepts a BlogPosting + FAQPage @graph", () => {
    const valid = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BlogPosting",
          headline: "Test",
          description: "Test description",
        },
        {
          "@type": "FAQPage",
          mainEntity: [
            { "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A" } },
          ],
        },
      ],
    });
    expect(isValidJsonLd(valid)).toBe(true);
  });

  it("accepts a single BlogPosting with @type at root", () => {
    const valid = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Test",
    });
    expect(isValidJsonLd(valid)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidJsonLd("")).toBe(false);
  });

  it("rejects malformed JSON (Claude emits backtick fences)", () => {
    expect(isValidJsonLd("```json\n{\"@context\":\"https://schema.org\"}\n```")).toBe(false);
  });

  it("rejects truncated JSON (Claude hits max_tokens mid-emission)", () => {
    expect(isValidJsonLd('{"@context":"https://schema.org","@graph":[{"@type":"Blog')).toBe(false);
  });

  it("rejects wrong @context", () => {
    const wrongContext = JSON.stringify({
      "@context": "https://something-else.org",
      "@type": "BlogPosting",
    });
    expect(isValidJsonLd(wrongContext)).toBe(false);
  });

  it("rejects missing @context", () => {
    const noContext = JSON.stringify({
      "@type": "BlogPosting",
      headline: "x",
    });
    expect(isValidJsonLd(noContext)).toBe(false);
  });

  it("rejects @context present but no @type and no @graph", () => {
    const onlyContext = JSON.stringify({
      "@context": "https://schema.org",
      headline: "x",
    });
    expect(isValidJsonLd(onlyContext)).toBe(false);
  });

  it("rejects non-JSON garbage", () => {
    expect(isValidJsonLd("hello world")).toBe(false);
    expect(isValidJsonLd("not json at all")).toBe(false);
  });

  it("rejects JSON parsing to a primitive (not an object)", () => {
    expect(isValidJsonLd('"a string"')).toBe(false);
    expect(isValidJsonLd("42")).toBe(false);
    expect(isValidJsonLd("null")).toBe(false);
  });

  it("rejects unescaped quotes from a brittle LLM emission", () => {
    expect(isValidJsonLd('{"@context":"https://schema.org","headline":"5-7 "reports""}')).toBe(false);
  });
});
