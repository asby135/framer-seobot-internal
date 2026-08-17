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

  const queryTerms = tokenize(query);
  const idf = computeIDF(queryTerms);

  const scored = articles.map((article) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = article.terms.get(term) || 0;
      const idfScore = idf.get(term) || 0;
      score += tf * idfScore;
    }
    return { ...article, score };
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
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
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
