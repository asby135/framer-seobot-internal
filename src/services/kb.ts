import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";

interface KBArticle {
  filename: string;
  title: string;
  content: string;
  terms: Map<string, number>; // term -> TF score
}

let articles: KBArticle[] = [];

/**
 * Load all .md files from the knowledge base directory.
 * Simple TF-IDF matching — semantic search is overkill for 25 docs.
 */
export function loadKB(dir: string): void {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  articles = files.map((f) => {
    const content = readFileSync(join(dir, f), "utf-8");
    const title = extractTitle(content, f);
    const terms = computeTF(content);
    return { filename: f, title, content, terms };
  });
  logger.info({ count: articles.length }, "Knowledge base loaded");
}

/**
 * Retrieval pins: for topics where one KB doc describes the strategically
 * preferred approach, TF-IDF alone can bury it under more numerous docs about
 * an adjacent approach. A pin force-includes its doc (at the top of the result)
 * whenever the query matches one of its trigger phrases — so the preferred
 * workflow is always in front of the generator, not crowded out.
 *
 * Matching is whole-word/phrase (see queryMatchesKeyword) so short triggers
 * like "cis" don't match substrings such as "decision".
 */
interface KBPin {
  file: string;
  keywords: string[];
}

const PINS: KBPin[] = [
  {
    // Prefer the DataNewton -> CRMChat contact-lookup ("mention") workflow over
    // group parsing for decision-maker / founder / B2B prospect-sourcing topics.
    file: "finding-decision-makers-ru-cis.md",
    keywords: [
      "decision maker",
      "decision makers",
      "decision-maker",
      "decision-makers",
      "founder",
      "founders",
      "business owner",
      "business owners",
      "prospect list",
      "prospect database",
      "lead list",
      "company database",
      "datanewton",
      "cis",
    ],
  },
];

/** Whole-word / phrase match of `keyword` against `query`. */
function queryMatchesKeyword(query: string, keyword: string): boolean {
  const norm =
    " " +
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim() +
    " ";
  return norm.includes(" " + keyword + " ");
}

/**
 * Find the top-k most relevant KB articles for a given query.
 * Returns the full content of matched articles for context injection.
 *
 * Pinned docs (see PINS) whose trigger phrases appear in the query are placed
 * first and always included; remaining slots are filled by TF-IDF relevance.
 */
export function searchKB(
  query: string,
  topK = 3
): Array<{ filename: string; title: string; content: string; score: number }> {
  if (articles.length === 0) return [];

  const queryTerms = [...new Set(tokenize(query))];
  const idf = computeIDF(queryTerms);

  // A term on most pages ("telegram", "crm") says nothing about which page
  // fits, but its IDF never fell below 1, so it decided matches on its own.
  // If EVERY query term is that common ("telegram outreach"), fall back to all
  // of them — returning nothing for a core head term set low_kb_match on it.
  const uncommon = queryTerms.filter((t) => documentShare(t) < UBIQUITOUS_SHARE);
  const informative = uncommon.length > 0 ? uncommon : queryTerms;
  // And a page must share at least two such terms with the query (one, for a
  // one-term query). Any single overlap used to count: "how to bake sourdough
  // bread at home" matched the privacy policy, so the low_kb_match flag could
  // never fire for an off-topic topic.
  const minMatched = Math.min(2, informative.length);

  const scored = articles.map((article) => {
    if (NOT_SEARCHABLE.has(article.filename)) return { ...article, score: 0 };
    let score = 0;
    let matched = 0;
    for (const term of informative) {
      const tf = article.terms.get(term) || 0;
      if (tf === 0) continue;
      matched++;
      score += tf * (idf.get(term) || 0);
    }
    return { ...article, score: matched >= minMatched ? score : 0 };
  });

  const byFile = new Map(scored.map((a) => [a.filename, a]));
  const ranked = scored
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: typeof scored = [];
  const seen = new Set<string>();

  // 1. Pinned docs first (guaranteed inclusion, even if TF-IDF score is 0).
  for (const pin of PINS) {
    if (!pin.keywords.some((k) => queryMatchesKeyword(query, k))) continue;
    const art = byFile.get(pin.file);
    if (art && !seen.has(pin.file)) {
      out.push(art);
      seen.add(pin.file);
    }
  }

  // 2. Fill remaining slots with top TF-IDF matches.
  for (const a of ranked) {
    if (out.length >= topK) break;
    if (!seen.has(a.filename)) {
      out.push(a);
      seen.add(a.filename);
    }
  }

  return out
    .slice(0, topK)
    .map(({ filename, title, content, score }) => ({
      filename,
      title,
      content,
      score,
    }));
}

export function getKBArticleCount(): number {
  return articles.length;
}

/**
 * Fetch a KB doc by filename, for callers that know exactly which grounding
 * they want rather than relying on TF-IDF to surface it.
 *
 * Used by the seeder's `kb_hints`: niches with thin keyword overlap (RU SaaS,
 * currency exchanges) retrieve noise from a relevance search, so their
 * grounding is pinned explicitly instead.
 */
export function getKBArticle(
  filename: string
): { filename: string; title: string; content: string } | undefined {
  const found = articles.find((a) => a.filename === filename);
  if (!found) return undefined;
  return { filename: found.filename, title: found.title, content: found.content };
}

// --- Internal helpers ---

function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  return filename.replace(/\.md$/, "").replace(/-/g, " ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    .map(stem);
}

function computeTF(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  // Normalize by doc length
  const len = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, count] of freq) {
    tf.set(term, count / len);
  }
  return tf;
}

/**
 * Pages search never returns. Legal text is long and full of generic words
 * ("data", "client", "service", "providers"), so long persona queries matched
 * it — the privacy policy grounded media-buying seeds — and it is never what an
 * article should be grounded in. Still reachable by name (getKBArticle).
 */
const NOT_SEARCHABLE = new Set(["privacy-policy.md", "data-handling-policy.md"]);

/** A term on at least this share of pages carries no signal about which fits. */
const UBIQUITOUS_SHARE = 0.8;

function documentShare(term: string): number {
  if (articles.length === 0) return 0;
  let count = 0;
  for (const a of articles) if (a.terms.has(term)) count++;
  return count / articles.length;
}

/**
 * Fold word forms onto one term: "parse", "parser" and "parsing" were three
 * different words, so "How to Parse Telegram Groups" missed the group-parser
 * pages under any scoring. Crude on purpose — it only has to be consistent
 * between query and page, which it is, since both go through tokenize.
 */
function stem(word: string): string {
  let w = word;
  for (const suffix of ["ations", "ation", "ings", "ing", "ers", "er", "ies", "es", "ed", "s"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
      w = suffix === "ies" ? `${w.slice(0, -3)}y` : w.slice(0, -suffix.length);
      break;
    }
  }
  // "parse" and "parsing" must meet at "pars", "message" and "messages" at
  // "messag": drop a trailing e, whether or not a suffix came off.
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function computeIDF(queryTerms: string[]): Map<string, number> {
  const n = articles.length || 1;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    let docCount = 0;
    for (const article of articles) {
      if (article.terms.has(term)) docCount++;
    }
    // Standard IDF with smoothing
    idf.set(term, Math.log((n + 1) / (docCount + 1)) + 1);
  }
  return idf;
}

const STOP_WORDS = new Set([
  // Listicle words: "best"/"top" match every page that praises anything, and
  // left "Best Telegram CRM" ranked by "best" alone.
  "best",
  "top",
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "have",
  "been",
  "from",
  "this",
  "that",
  "with",
  "they",
  "will",
  "each",
  "make",
  "like",
  "how",
  "what",
  "when",
  "which",
  "their",
  "there",
  "these",
  "than",
  "other",
  "into",
  "could",
  "would",
  "about",
  "your",
  "also",
  "just",
  "more",
  "some",
  "very",
  "then",
]);

/**
 * How much of one knowledge-base page reaches a prompt.
 *
 * Was 2,000, which cut 49 of 63 pages — pricing.md mid-table, the RU/CIS
 * workflow before its setup steps. 8,000 passes 59 pages whole; the four
 * longer ones (privacy policy, best-practices, two API pages) are rarely the
 * grounding that matters, and a bound keeps four retrieved pages to ~8K tokens.
 */
export const KB_EXCERPT_CHARS = 8000;

export function kbExcerpt(content: string): string {
  if (content.length <= KB_EXCERPT_CHARS) return content;
  return `${content.slice(0, KB_EXCERPT_CHARS)}\n[…page truncated]`;
}

/**
 * The article as the fact-checker should read it: all of it, as text.
 *
 * It used to get the first 6,000 characters of HTML, which a 1,000-1,500 word
 * article exceeds — the second product mention the prompt places in a later
 * section was never checked. Markup is dropped so the whole article fits.
 */
export function articleTextForFactCheck(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre|figcaption)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Cells apart: "<td>Starter</td><td>$29</td>" read as "Starter$29".
    .replace(/<\/t[dh]>/gi, " ")
    // Inline markup vanishes ("A <a>link</a>." stays "A link."); anything
    // else is a boundary.
    .replace(/<\/?(a|strong|em|b|i|u|span|code|sup|sub)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
