import { describe, it, expect } from "vitest";
import { sanitizeHTML, stripLeakedJsonLd } from "./generator.js";

describe("stripLeakedJsonLd", () => {
  it("removes a bare FAQPage JSON-LD blob the model appended to the body", () => {
    const html =
      `<p>Developers integrating this into an existing stack can also use the ` +
      `<a href="/api">CRMChat API</a> to automate the conversion step directly.</p>\n\n` +
      `{"@context":"https://schema.org","@type":"FAQPage","mainEntity":` +
      `[{"@type":"Question","name":"How do you convert a phone number into a Telegram username?",` +
      `"acceptedAnswer":{"@type":"Answer","text":"You run the phone number through a lookup tool."}}]}`;

    const out = stripLeakedJsonLd(html);
    expect(out).toContain("automate the conversion step directly.");
    expect(out).not.toContain("@context");
    expect(out).not.toContain("FAQPage");
    expect(out.trimEnd().endsWith("</p>")).toBe(true);
  });

  it("removes a truncated (cut-off) trailing schema blob", () => {
    const html = `<p>Body text.</p>\n{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Why`;
    const out = stripLeakedJsonLd(html);
    expect(out).toBe("<p>Body text.</p>");
  });

  it("drops a dangling wrapper tag left by removing the JSON", () => {
    const html = `<p>Body.</p>\n<p>{"@type":"FAQPage","mainEntity":[]}</p>`;
    const out = stripLeakedJsonLd(html);
    expect(out).toBe("<p>Body.</p>");
  });

  it("leaves normal article HTML untouched", () => {
    const html = `<h2>How it works</h2><p>You connect an account and go.</p>`;
    expect(stripLeakedJsonLd(html)).toBe(html);
  });

  it("sanitizeHTML also strips leaked schema end-to-end", () => {
    const html =
      `<h2>Convert phone numbers</h2><p>Here is how.</p>` +
      `{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}`;
    const out = sanitizeHTML(html);
    expect(out).toContain("Convert phone numbers");
    expect(out).not.toContain("schema.org");
    expect(out).not.toContain("FAQPage");
  });
});
