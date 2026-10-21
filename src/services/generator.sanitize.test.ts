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

  // The model sometimes ends the body with a bare tag named after the tool
  // field. "_" is not tag syntax to the sanitizer, so it was escaped and shipped
  // as visible text: 8 live articles ended in "<schema_jsonld>".
  it.each([
    "<p>&lt;schema_jsonld&gt;</p>",
    "<p><schema_jsonld></p>",
    "<schema_jsonld></schema_jsonld>",
    "<p>&lt;schema_jsonld_placeholder/&gt;</p>",
  ])("removes a leaked schema field tag: %s", (leak) => {
    expect(sanitizeHTML(`<p>Last line.</p>${leak}`)).toBe("<p>Last line.</p>");
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

describe("sanitizeHTML — prose is never eaten", () => {
  // A raw "<" followed by a digit or space was read as the start of a tag, and
  // everything up to the next ">" — the rest of the sentence and the closing
  // tags — was deleted. The prompt asks for citable numbers, so "<5%" is common.
  it("keeps a sentence containing '<50'", () => {
    const out = sanitizeHTML("<p>Keep it under <50 messages per day to stay safe.</p><h2>Next</h2>");
    expect(out).toBe("<p>Keep it under &lt;50 messages per day to stay safe.</p><h2>Next</h2>");
  });

  it("keeps a sentence containing '<5%'", () => {
    const out = sanitizeHTML("<p>Reply rate <5% means trouble.</p><p>Second</p>");
    expect(out).toBe("<p>Reply rate &lt;5% means trouble.</p><p>Second</p>");
  });

  it("keeps '< 10' with a space", () => {
    expect(sanitizeHTML("<p>Use < 10 accounts at first.</p>")).toBe("<p>Use &lt; 10 accounts at first.</p>");
  });

  it("does not strip 'on...=' text from prose", () => {
    // The event-handler regex ran over the whole document, text included.
    expect(sanitizeHTML("<p>Set online=true in the config.</p>")).toBe("<p>Set online=true in the config.</p>");
  });

  it("keeps a schema.org example inside a code block", () => {
    const html = '<p>Example:</p><pre><code>{"@context": "https://schema.org", "@type": "FAQPage"}</code></pre><p>After</p>';
    expect(sanitizeHTML(html)).toContain("<p>After</p>");
  });
});

describe("sanitizeHTML — still strips what it must", () => {
  it("drops event-handler attributes, quoted or not", () => {
    expect(sanitizeHTML('<a href="https://x.com" onclick="evil()">x</a>')).toBe('<a href="https://x.com">x</a>');
    expect(sanitizeHTML('<img src="https://x.com/y.png" onerror=alert(1)>')).toBe('<img src="https://x.com/y.png">');
  });

  it("drops script and style blocks with their content", () => {
    expect(sanitizeHTML("<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>")).toBe("<p>a</p><p>b</p>");
  });

  it("drops disallowed tags but keeps their text", () => {
    expect(sanitizeHTML("<p>a <iframe src='https://x'></iframe><font>b</font></p>")).toBe("<p>a b</p>");
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java&#x09;script:alert(1)",
    "data:text/html,<script>",
    "vbscript:x",
  ])("removes an unsafe link target: %s", (url) => {
    expect(sanitizeHTML(`<a href="${url}">x</a>`)).toBe("<a>x</a>");
  });

  it.each(["https://crmchat.ai/blog/x", "/blog/x", "#faq", "mailto:hi@crmchat.ai"])(
    "keeps a safe link target: %s",
    (url) => {
      expect(sanitizeHTML(`<a href="${url}">x</a>`)).toBe(`<a href="${url}">x</a>`);
    }
  );
});

describe("sanitizeHTML — comments", () => {
  // Browsers end a comment at "<!-->", "<!--->" or "--!>", earlier than a
  // lazy /<!--[\s\S]*?-->/ thinks — so passing comments through let markup
  // hidden "inside" one reach the page.
  it.each([
    "<!--><img src=x onerror=alert(1)>-->",
    "<!---><img src=x onerror=alert(1)>-->",
    "<!-- a --!><img src=x onerror=alert(1)> -->",
  ])("does not let markup escape a comment: %s", (html) => {
    expect(sanitizeHTML(html)).not.toMatch(/onerror/i);
  });

  it("keeps the screenshot placeholder the asset pipeline needs", () => {
    const html = "<p>a</p><!-- screenshot:https://kommo.com/pricing --><p>b</p>";
    expect(sanitizeHTML(html)).toBe(html);
  });

  it("drops a placeholder whose URL could break out of an attribute", () => {
    expect(sanitizeHTML('<!-- screenshot:https://x.com/"onload="alert(1) -->')).not.toMatch(/screenshot/);
  });

  it("drops any other comment", () => {
    expect(sanitizeHTML("<p>a</p><!-- note to self --><p>b</p>")).toBe("<p>a</p><p>b</p>");
  });
});

describe("sanitizeHTML — brand", () => {
  it("writes the brand in lowercase in text, leaving links intact", () => {
    expect(sanitizeHTML('<p><a href="https://crmchat.ai/">CRMChat</a> and CRMchat.</p>')).toBe(
      '<p><a href="https://crmchat.ai/">crmchat</a> and crmchat.</p>'
    );
  });
});

describe("sanitizeHTML — hardening", () => {
  it("allows Telegram deep links", () => {
    expect(sanitizeHTML('<a href="tg://resolve?domain=crmchat">x</a>')).toBe('<a href="tg://resolve?domain=crmchat">x</a>');
  });

  it("stays fast on adversarial input", () => {
    const started = Date.now();
    sanitizeHTML("<a ".repeat(50_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
