/**
 * Lexical near-duplicate detection for article titles.
 *
 * Exists because every other guard is either exact (same text, same slug) or
 * short-sighted (the seeder prompt lists only the most recent ~90 topics and
 * titles). Against a corpus of several hundred articles, a reworded repeat of
 * anything older than that list passed every check and would have been written
 * a second time, to compete with the first in search.
 *
 * Deliberately lexical, not semantic: it runs on every insert against the whole
 * corpus for free, and it cannot hallucinate a match. It will not catch two
 * titles that share a meaning but no words ("CRM for crypto teams" / "sales
 * tooling for Web3") — that remains the seeder prompt's job.
 *
 * Pure — no DB, no network.
 */

/**
 * Jaccard score at or above which two titles are treated as the same article.
 *
 * Chosen against the live corpus (436 published titles, 2026-09): the closest
 * pair of genuinely different articles scored 0.44, while rewordings of one
 * task land at 0.6 and up. Lower it and sibling tasks inside a subniche start
 * being refused; raise it and light rewordings get through.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/**
 * Words that say nothing about WHICH task a title is.
 *
 * Function words, plus the title-shape words the seeder is told to use ("how
 * to", "what is … explained", "fix", "why") so that a what-is and a how-to on
 * one subject still register as the same ground. "telegram" is here because
 * nearly every title on the blog contains it: left in, it makes unrelated
 * titles look alike.
 */
const STOPWORDS = new Set(
  (
    "a an the and or but for of in on at to from by with without into onto over under about as per via vs " +
    "is are was be been it its this that these those your you their our we they who which when where " +
    "how what why fix explained explain guide work " +
    "do does did can get got gets not no " +
    "set up setup use using " +
    "telegram"
  ).split(" ")
);

/** Crude stemmer: enough to fold plurals and -ing/-ed forms onto one token. */
function stem(word: string): string {
  let w = word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The set of meaningful, stemmed words in a title. */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    // Two-letter tokens stay: "ml", "ai" and "p2p"-style terms carry the topic.
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!STOPWORDS.has(s)) out.add(s);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  // Two titles with no meaningful words are unrelated, not identical.
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** 0 (nothing in common) to 1 (same meaningful words). */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(titleTokens(a), titleTokens(b));
}

/**
 * A pre-tokenised corpus, for checking many candidates against the same titles
 * without re-tokenising the corpus for each one.
 */
export interface TitleIndex {
  /** The existing title `candidate` is too close to, if any. */
  match(candidate: string): string | undefined;
  /** Add a title, so later candidates are checked against it too. */
  add(title: string): void;
}

export function createTitleIndex(
  titles: string[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD
): TitleIndex {
  const entries = titles.map((title) => ({ title, tokens: titleTokens(title) }));
  return {
    match(candidate) {
      const tokens = titleTokens(candidate);
      let best: { title: string; score: number } | undefined;
      for (const e of entries) {
        const score = jaccard(tokens, e.tokens);
        if (score >= threshold && (!best || score > best.score)) best = { title: e.title, score };
      }
      return best?.title;
    },
    add(title) {
      entries.push({ title, tokens: titleTokens(title) });
    },
  };
}

/** The closest existing title at or above the threshold, if any. */
export function findNearDuplicate(
  candidate: string,
  existing: string[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD
): string | undefined {
  return createTitleIndex(existing, threshold).match(candidate);
}
