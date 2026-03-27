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
 * Find the top-k most relevant KB articles for a given query.
 * Returns the full content of matched articles for context injection.
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

  return scored
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
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
