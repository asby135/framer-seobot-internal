import { describe, it, expect } from "vitest";
import { lintArticle } from "./guide-lint.js";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

/** A short article that follows every checkable rule. */
function goodArticle(extra = ""): string {
  return [
    "<p><strong>Key takeaways</strong></p>",
    "<ul>",
    `<li><p>${words(18)}.</p></li>`,
    `<li><p>${words(18)}.</p></li>`,
    `<li><p>${words(18)}.</p></li>`,
    `<li><p>${words(18)}.</p></li>`,
    "</ul>",
    `<p>${words(25)}. ${words(25)}.</p>`,
    "<table><tbody><tr><th><p>Tool</p></th><th><p>Price</p></th></tr>",
    '<tr><td><p>Acme</p></td><td><p><a href="https://acme.example/pricing">$10 a month</a></p></td></tr></tbody></table>',
    "<h2>How does Acme handle Telegram leads?</h2>",
    `<p>Acme syncs chats into a pipeline. ${words(20)}. See <a href="/blog/a">our setup guide</a>.</p>`,
    "<h2>Which stack fits a small team?</h2>",
    `<p>Pick one tool per job. ${words(20)}. Read <a href="/blog/b">the outreach checklist</a> and <a href="/blog/c">pipeline basics</a>.</p>`,
    extra,
    "<h2>FAQ</h2>",
    "<h3>Is Acme free?</h3><p>It has a free plan. Paid plans cost more.</p>",
    "<h3>Does Acme work on mobile?</h3><p>Yes. The app runs on iOS and Android.</p>",
    "<h3>Can Acme import contacts?</h3><p>Yes, from a CSV file.</p>",
  ].join("");
}

describe("lintArticle", () => {
  it("passes an article that follows the guide", () => {
    expect(lintArticle(goodArticle(), { needsTable: true })).toEqual([]);
  });

  it("asks for key takeaways first", () => {
    const html = goodArticle().replace("<p><strong>Key takeaways</strong></p>", "<p>Intro</p>");
    expect(lintArticle(html, { needsTable: true }).join(" ")).toMatch(/Key takeaways/);
  });

  it("requires a table only where one is needed", () => {
    const html = goodArticle().replace(/<table>[\s\S]*?<\/table>/, "");
    expect(lintArticle(html, { needsTable: true }).join(" ")).toMatch(/comparison table/);
    expect(lintArticle(html, { needsTable: false })).toEqual([]);
  });

  it("flags em dashes and banned phrasing", () => {
    const issues = lintArticle(goodArticle("<p>A seamless flow — really.</p>"), { needsTable: true }).join(" ");
    expect(issues).toMatch(/em dash/);
    expect(issues).toMatch(/seamless/);
  });

  it("bans 'leverage' as filler, not as the trading term", () => {
    expect(lintArticle(goodArticle("<p>Leverage your data today.</p>"), { needsTable: true }).join(" ")).toMatch(/leverage/);
    expect(lintArticle(goodArticle("<p>Brokers cap leverage for retail traders.</p>"), { needsTable: true })).toEqual([]);
  });

  it("flags sentences over 35 words, judged per block", () => {
    const issues = lintArticle(goodArticle(`<p>${words(40)}.</p>`), { needsTable: true }).join(" ");
    expect(issues).toMatch(/over 35 words/);
  });

  it("flags statement headings and oversized sections", () => {
    const extra = `<h2>Our pick</h2><p>${words(30)}.</p><h2>Another pick</h2><p>${Array.from({ length: 12 }, () => `${words(20)}.`).join(" ")}</p>`;
    const issues = lintArticle(goodArticle(extra), { needsTable: true }).join(" ");
    expect(issues).toMatch(/headings as reader questions/);
    expect(issues).toMatch(/without a sub-heading/);
  });

  it("flags long link text and a missing FAQ", () => {
    const html = goodArticle()
      .replace("our setup guide", "how to set up your first Telegram pipeline step by step")
      .replace(/<h2>FAQ<\/h2>[\s\S]*$/, "");
    const issues = lintArticle(html, { needsTable: true }).join(" ");
    expect(issues).toMatch(/2-5 words/);
    expect(issues).toMatch(/FAQ/);
  });

  it("flags claim numbers with no source, but not dates or form numbers", () => {
    expect(lintArticle(goodArticle("<p>Plans cost $49 a month.</p>"), { needsTable: true }).join(" ")).toMatch(
      /Link the source/
    );
    const benign = "<p>We checked each site on 21 October 2026 and filed Form 8949 for a team of 10.</p>";
    expect(lintArticle(goodArticle(benign), { needsTable: true })).toEqual([]);
  });
});
