import { describe, it, expect } from "vitest";
process.env.ANTHROPIC_API_KEY ??= "test";
const { runQualityChecks, articleTypeOf } = await import("./generator.js");

/**
 * The post-generation checks, made to agree with the prompt.
 *
 * They contradicted it: an 800-word floor for every article while the prompt
 * tells what-is articles to stay at 400-450 words and troubleshooting at
 * 600-1,000; and an exact-substring "keyword in title / first paragraph" test
 * while the prompt says the keyword is a seed, not the title. Nearly every
 * article was flagged, so a real problem looked like routine noise.
 */
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const article = (title: string, body: string, content?: string) => ({
  title,
  slug: "s",
  category: "c",
  summary: "s",
  content: content ?? `<p>${body}</p>`,
  schema_jsonld: "",
});
const lengthIssues = (issues: string[]) => issues.filter((i) => /too (short|long)/i.test(i));

describe("articleTypeOf", () => {
  it.each([
    ["What Is Telegram Account Warmup Explained", "what-is"],
    ["Telegram Folder Sync Not Working", "troubleshooting"],
    ["Why Media Buyers Ghost After Requesting Ad Account Pricing", "troubleshooting"],
    ["Fix a Telegram Bot That Stopped Sending Updates", "troubleshooting"],
    ["Kommo vs CRMChat for Telegram Sales Teams", "comparison"],
    ["Best Telegram CRM Tools for Crypto Funds", "tops"],
    ["How to Export Telegram Group Members to CSV", "how-to"],
    ["Your Telegram Account Keeps Getting Restricted. Here's Why", "troubleshooting"],
    ["Telegram Bot Won’t Send Messages", "troubleshooting"],
    ["What Are Telegram Session Files", "what-is"],
    ["What Does Shadowban Mean on Telegram", "what-is"],
    ["How to Avoid Telegram Account Bans When Bulk Messaging", "how-to"],
  ])("%s → %s", (q, type) => {
    expect(articleTypeOf(q)).toBe(type);
  });
});

describe("length is judged against the article's own type", () => {
  it("accepts a 430-word what-is article", () => {
    const t = "What Is a Telegram Session String Explained";
    expect(lengthIssues(runQualityChecks(article(t, `${t.toLowerCase()} ${words(425)}`), t, new Set()))).toEqual([]);
  });

  it("flags a 430-word how-to as too short", () => {
    const t = "How to Export Telegram Group Members to CSV";
    expect(lengthIssues(runQualityChecks(article(t, `${t.toLowerCase()} ${words(425)}`), t, new Set()))).toHaveLength(1);
  });

  it("accepts a 700-word troubleshooting article", () => {
    const t = "Telegram Folder Sync Not Working";
    expect(lengthIssues(runQualityChecks(article(t, `${t.toLowerCase()} ${words(695)}`), t, new Set()))).toEqual([]);
  });

  it("flags a 1,300-word what-is as too long", () => {
    const t = "What Is a Telegram Session String Explained";
    expect(lengthIssues(runQualityChecks(article(t, `${t.toLowerCase()} ${words(1300)}`), t, new Set()))).toHaveLength(1);
  });
});

describe("the topic is checked by its meaningful words, not as an exact string", () => {
  const q = "how to write a ppv sales script";

  it("accepts a title that covers the topic in other words", () => {
    const issues = runQualityChecks(
      article("How to Write a PPV Sales Script That Gets Fans to Buy Fast", `A PPV sales script is what you send… ${words(1100)}`),
      q,
      new Set()
    );
    expect(issues.filter((i) => /title/i.test(i))).toEqual([]);
  });

  it("accepts a first paragraph that introduces the topic without quoting it", () => {
    const issues = runQualityChecks(
      article("How to Write a PPV Sales Script", `Writing a good PPV script for sales starts with… ${words(1100)}`),
      q,
      new Set()
    );
    expect(issues.filter((i) => /first paragraph/i.test(i))).toEqual([]);
  });

  it("still flags a title that has drifted off the topic", () => {
    const issues = runQualityChecks(article("Ten Ways to Grow a Fan Base", `ppv sales script ${words(1100)}`), q, new Set());
    expect(issues.some((i) => /title/i.test(i))).toBe(true);
  });
});

describe("internal links", () => {
  it("still flags a link to a page that does not exist", () => {
    const t = "How to Export Telegram Group Members to CSV";
    const issues = runQualityChecks(
      article(t, "", `<p>${t.toLowerCase()} ${words(1100)} <a href="/blog/nope">x</a></p>`),
      t,
      new Set(["real"])
    );
    expect(issues).toContain("Broken internal link: /blog/nope");
  });
});
