import { describe, it, expect } from "vitest";
import { isValidJsonLd, sanitizeJsonLd, faqVerdict } from "./jsonld.js";

describe("isValidJsonLd", () => {
  it("accepts a BlogPosting + FAQPage @graph", () => {
    const valid = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "BlogPosting", headline: "Test", description: "Test description" },
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
    expect(
      isValidJsonLd(JSON.stringify({ "@context": "https://schema.org", "@type": "BlogPosting", headline: "Test" }))
    ).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidJsonLd("")).toBe(false);
  });

  it("rejects malformed JSON (backtick fences)", () => {
    expect(isValidJsonLd("```json\n{\"@context\":\"https://schema.org\"}\n```")).toBe(false);
  });

  it("rejects truncated JSON (max_tokens cutoff)", () => {
    expect(isValidJsonLd('{"@context":"https://schema.org","@graph":[{"@type":"Blog')).toBe(false);
  });

  it("rejects wrong @context", () => {
    expect(
      isValidJsonLd(JSON.stringify({ "@context": "https://something-else.org", "@type": "BlogPosting" }))
    ).toBe(false);
  });

  it("rejects missing @context", () => {
    expect(isValidJsonLd(JSON.stringify({ "@type": "BlogPosting", headline: "x" }))).toBe(false);
  });

  it("rejects @context present but no @type and no @graph", () => {
    expect(isValidJsonLd(JSON.stringify({ "@context": "https://schema.org", headline: "x" }))).toBe(false);
  });

  it("rejects non-JSON garbage", () => {
    expect(isValidJsonLd("hello world")).toBe(false);
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

describe("sanitizeJsonLd", () => {
  it("returns an HTML-script-safe string for valid JSON-LD", () => {
    const valid = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Telegram CRM pricing",
    });
    const out = sanitizeJsonLd(valid);
    expect(out).not.toBeNull();
    // Result must still parse as the same document
    expect(JSON.parse(out!)).toEqual(JSON.parse(valid));
  });

  it("escapes a </script> breakout payload so it cannot close the tag", () => {
    // An LLM could innocently put this in an FAQ answer that quotes HTML.
    // It is VALID JSON, so isValidJsonLd alone would let it through.
    const xssPayload = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "How to use </script><script>alert(1)</script> in Telegram",
    });
    expect(isValidJsonLd(xssPayload)).toBe(true); // valid JSON — the trap

    const out = sanitizeJsonLd(xssPayload);
    expect(out).not.toBeNull();
    // No literal < or > survive — cannot break out of a <script> tag
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    // Still parses back to the original document (escaping is transparent to JSON)
    expect(JSON.parse(out!)).toEqual(JSON.parse(xssPayload));
  });

  it("escapes ampersands", () => {
    const withAmp = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "CRM & outreach",
    });
    const out = sanitizeJsonLd(withAmp);
    expect(out).not.toContain("&");
    expect(out).toContain("\\u0026");
    expect(JSON.parse(out!)).toEqual(JSON.parse(withAmp));
  });

  it("escapes U+2028 and U+2029 line separators", () => {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const withSep = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: `line${LS}sep${PS}here`,
    });
    const out = sanitizeJsonLd(withSep);
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(JSON.parse(out!)).toEqual(JSON.parse(withSep));
  });

  it("returns null for invalid JSON-LD (does not throw)", () => {
    expect(sanitizeJsonLd("")).toBeNull();
    expect(sanitizeJsonLd("not json")).toBeNull();
    expect(sanitizeJsonLd('{"@context":"https://wrong.org","@type":"X"}')).toBeNull();
    expect(sanitizeJsonLd('{"@context":"https://schema.org"}')).toBeNull();
  });
});

describe("faqVerdict", () => {
  const faq = (pairs: number) =>
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: Array.from({ length: pairs }, (_, i) => ({
        "@type": "Question",
        name: `Q${i}?`,
        acceptedAnswer: { "@type": "Answer", text: `A${i}` },
      })),
    });

  it("passes a well-formed FAQPage", () => {
    expect(faqVerdict(faq(3))).toBe("ok");
  });

  it("reports an empty or absent value as missing", () => {
    expect(faqVerdict(null)).toBe("missing");
    expect(faqVerdict("")).toBe("missing");
    expect(faqVerdict("   ")).toBe("missing");
  });

  it("reports unparseable JSON as invalid", () => {
    expect(faqVerdict("{oops")).toBe("invalid");
  });

  it("reports valid JSON-LD that is not a FAQPage", () => {
    // Framer emits BlogPosting itself; a BlogPosting here means the model
    // produced the one node it was told not to.
    expect(
      faqVerdict(JSON.stringify({ "@context": "https://schema.org", "@type": "BlogPosting" }))
    ).toBe("not-faq");
  });

  it("finds a FAQPage nested in an @graph", () => {
    expect(
      faqVerdict(
        JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [{ "@type": "BlogPosting" }, JSON.parse(faq(2))],
        })
      )
    ).toBe("ok");
  });

  it("reports a single-pair FAQ as thin", () => {
    // Parses and validates, but the prompt asks for 2-6 — one pair is the
    // shape a truncated or retried generation leaves behind.
    expect(faqVerdict(faq(1))).toBe("thin");
  });

  it("does not count a Question with no answer text", () => {
    const half = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Q1?", acceptedAnswer: { "@type": "Answer", text: "A1" } },
        { "@type": "Question", name: "Q2?" },
      ],
    });
    expect(faqVerdict(half)).toBe("thin");
  });
});
