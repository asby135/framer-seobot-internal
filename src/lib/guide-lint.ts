/**
 * The writing guide's checkable rules, run over a generated article body.
 *
 * The prompt states these rules, but a prompt is a request: the model skips
 * some on most articles. This is the part that can be counted, so it is
 * counted. Each problem comes back as one plain sentence; the generator sends
 * them to the model for one revision pass, and whatever survives goes to the
 * operator with the article.
 */

const BANNED = [
  "seamless", "unlock", "empower", "elevate", "revolutioniz", "game-changer", "game changer",
  "robust", "streamline", "cutting-edge", "best-in-class", "world-class", "ultimate", "synergy",
  "delve", "tapestry", "testament to", "realm", "myriad", "plethora", "embark", "paramount",
  "harness the power", "in today's", "ever-evolving", "now more than ever", "in conclusion", "to sum up",
  "at the end of the day", "depends on your needs", "that being said", "having said that",
  "needless to say", "it's worth noting", "let's dive", "whether you're", "it's not about",
  "might potentially", "could perhaps", "helps teams work smarter", "the sections below",
  "the faq below", "most roundups", "unlike other guides", "as mentioned above", "earlier we covered",
];

export interface GuideLintOptions {
  /** Listicles and comparisons must carry a comparison table. */
  needsTable: boolean;
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const clip = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s);

/** Every guide rule this article breaks, as one sentence each. Empty when it passes. */
export function lintArticle(html: string, opts: GuideLintOptions): string[] {
  const issues: string[] = [];
  const body = html.trim();
  const plain = text(body);
  const lower = plain.toLowerCase();

  // 1. Key takeaways first, 3-5 items, about 50-100 words.
  const takeaways = body.match(
    /^<(?:p|h2|h3)>\s*(?:<strong>)?\s*Key takeaways:?\s*(?:<\/strong>)?\s*<\/(?:p|h2|h3)>\s*<ul>([\s\S]*?)<\/ul>/i
  );
  if (!takeaways) {
    issues.push('Start the article with a "Key takeaways" list of 3-5 items.');
  } else {
    const items = (takeaways[1].match(/<li/g) ?? []).length;
    const w = words(text(takeaways[1]));
    if (items < 3 || items > 5) issues.push(`Key takeaways has ${items} items; use 3-5.`);
    if (w < 40 || w > 120) issues.push(`Key takeaways runs ${w} words; aim for 50-100.`);
    // 2. Intro of 40-60 words right after the takeaways.
    const intro = body.slice(takeaways.index! + takeaways[0].length).match(/^\s*<p>([\s\S]*?)<\/p>/);
    const iw = intro ? words(text(intro[1])) : 0;
    if (iw < 30 || iw > 80) issues.push(`The intro after the takeaways runs ${iw} words; write 40-60 that answer the title.`);
  }

  // 3. Comparison table for listicles and comparisons.
  if (opts.needsTable && !/<table/i.test(body)) {
    issues.push("Add a comparison table of every product right after the intro.");
  }

  // 4. Dashes and banned phrasing.
  if (/—/.test(plain)) issues.push("Replace every em dash (—) with a full stop, comma, colon or brackets.");
  if (/\s--\s|\w--\w/.test(plain)) issues.push("Remove double hyphens (--).");
  const banned = BANNED.filter((b) => lower.includes(b));
  // "Leverage" is banned as filler verb only; in trading it is the borrowing
  // ratio ("50:1 leverage") and must stay.
  if (/\bleverag(?:e|es|ing)\s+(?:your|our|the|this|these|their|its|it|ai|data|existing)\b/.test(lower)) banned.unshift("leverage");
  if (banned.length) issues.push(`Remove banned phrasing: ${banned.join(", ")}.`);
  if ((plain.match(/!/g) ?? []).length > 1) issues.push("Use at most one exclamation mark.");

  // 5. Sentences over 35 words, per block so list items and cells are not merged.
  const blocks = [...body.matchAll(/<(p|li|td|th)>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]));
  const long = blocks.flatMap((b) => b.split(/(?<=[.!?])\s+/)).filter((s) => words(s) > 35);
  if (long.length) issues.push(`Split ${long.length} sentence(s) over 35 words, e.g. "${clip(long[0])}"`);

  // 6. Headings as questions, sections of a quotable size.
  const parts = body.split(/(<h2[^>]*>[\s\S]*?<\/h2>)/);
  const statements: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const head = text(parts[i]);
    const section = parts[i + 1] ?? "";
    if (/^(faq|key takeaways)/i.test(head)) continue;
    if (!head.endsWith("?")) statements.push(head);
    for (const chunk of section.split(/<h3[^>]*>[\s\S]*?<\/h3>/)) {
      const w = words(text(chunk.replace(/<table[\s\S]*?<\/table>/g, "")));
      if (w > 220) {
        issues.push(`The section "${clip(head)}" runs ${w} words without a sub-heading; split it (120-180 each).`);
        break;
      }
    }
  }
  if (statements.length > 1) {
    issues.push(`Phrase headings as reader questions; ${statements.length} are statements, e.g. "${clip(statements[0])}".`);
  }

  // 7. Lists of exactly three in many sections.
  const threes = [...body.matchAll(/<(ul|ol)>([\s\S]*?)<\/\1>/g)].filter((m) => (m[2].match(/<li/g) ?? []).length === 3);
  if (threes.length > 1) issues.push(`${threes.length} lists have exactly three items; vary their length.`);

  // 8. FAQ of 3-5 questions at the end.
  const faq = body.split(/<h2[^>]*>\s*FAQ\s*<\/h2>/i);
  if (faq.length < 2) {
    issues.push("End with an <h2>FAQ</h2> of 3-5 questions.");
  } else {
    const q = (faq[faq.length - 1].match(/<h3/g) ?? []).length;
    if (q < 3 || q > 5) issues.push(`The FAQ has ${q} questions; use 3-5.`);
  }

  // 9. Internal links: 3-5, anchors of 2-5 words.
  const internal = [...body.matchAll(/<a href="\/blog\/[^"]+"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1]));
  if (internal.length < 3 || internal.length > 5) issues.push(`Use 3-5 internal links; there are ${internal.length}.`);
  const longAnchors = internal.filter((a) => words(a) > 5 || words(a) < 2);
  if (longAnchors.length) issues.push(`Shorten link text to 2-5 words, e.g. "${clip(longAnchors[0])}".`);

  // 10. Numbers without a source link in the same block. Only claim-shaped
  // numbers count: money, percentages, thousands and millions, 100 and up.
  // Dates ("21 October 2026"), team sizes ("team of 10") and form numbers
  // ("Form 8949") are not claims.
  const CLAIM = /\$\s?\d|\d+(?:[.,]\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?[KkMm]\b\+?|\b(?!(?:19|20)\d{2}\b)(?!0)\d{3,}\+?/;
  // Numbers that name things rather than claim them: "MT103", "pacs.008",
  // "ISO 20022". Once a number appears as part of a name in the article, a
  // bare mention of it ("103 identifies the message type") is a name too.
  const nameNumbers = new Set(
    [...plain.matchAll(/\b[A-Za-z]{2,}[.-]?(\d{2,})\b|\bISO\s+(\d+)/g)].map((m) => m[1] ?? m[2])
  );
  const withoutNames = (t: string) =>
    t
      .replace(/\b(?:Form|Schedule|Section|guideline|ISO)\s+[\w.()-]+/gi, "")
      .replace(/\b\d+\b/g, (n) => (nameNumbers.has(n) ? "" : n));
  const unsourced = [...body.matchAll(/<(p|li|td)>([\s\S]*?)<\/\1>/g)]
    .filter((m) => !/<a\s/i.test(m[2]))
    .map((m) => text(m[2]))
    .filter((t) => CLAIM.test(withoutNames(t)));
  if (unsourced.length) {
    issues.push(`Link the source of every number; ${unsourced.length} block(s) have none, e.g. "${clip(unsourced[0])}".`);
  }

  return issues;
}
