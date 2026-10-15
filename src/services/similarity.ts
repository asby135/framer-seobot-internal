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
 * titles that share a meaning but not their words ("Deliver Forex Signals" /
 * "Distributing Forex Signals") — for those the seeder shortlists neighbours()
 * and asks a model (see dropSemanticDuplicates).
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
 * to", "what is … explained", "fix", "why") so that rewordings of one task
 * match regardless of phrasing. Where a shape word changes the task —
 * troubleshooting vs setup — distinctTasks() says so on the raw text.
 * "telegram" is here because nearly every title on the blog contains it: left
 * in, it makes unrelated titles look alike.
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
  // "banned" -> "bann" -> "ban", matching "bans"; "stopped" -> "stop".
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ss|ll)$/.test(w)) w = w.slice(0, -1);
  return w;
}

/**
 * Words that put a title on the other side of a task: a title with one of
 * these and a title without are different articles even on the same subject
 * ("Schedule Messages" / "Cancel Scheduled Messages").
 */
const REVERSAL = new Set(
  [
    "cancel", "delete", "remove", "undo", "stop", "disable", "disconnect", "leave", "unsubscribe",
    "revoke", "unpin", "unblock", "unarchive", "unmute", "recover", "restore",
  ].map(stem)
);

/** Pairs of tasks that mirror each other. */
const OPPOSITES: Array<[string, string]> = (
  [
    ["export", "import"], ["add", "remove"], ["enable", "disable"], ["start", "stop"],
    ["join", "leave"], ["connect", "disconnect"], ["pin", "unpin"], ["block", "unblock"],
    ["subscribe", "unsubscribe"], ["upload", "download"], ["increase", "decrease"],
  ] as Array<[string, string]>
).map(([a, b]) => [stem(a), stem(b)]);

/**
 * A troubleshooting-shaped title: something broken, failing or questioned.
 * Shared with the generator's article-type check (articleTypeOf) so the two
 * cannot disagree about what "troubleshooting" means. Matched on raw text
 * because its words ("not", "work", "fix", "why") are stopwords — stripped so
 * that rewordings match, which also made "Folder Sync Not Working" a duplicate
 * of "Set Up Folder Sync".
 */
export const TROUBLESHOOTING_SHAPE =
  /^why\b|\bwhy\b|\b(not (working|sending|loading|showing|syncing|responding|delivering|receiving|connecting|updating|posting)|fix|fixing|broken|errors?|failed|fails|failing|stopped|stops|stuck|keeps? getting)\b|\b(won|can|doesn|isn|aren)['’]?t\b/i;

/**
 * For telling tasks apart, a title about a failure the subject suffers — a ban,
 * a restriction — is on the failure side too, so "Fix a Banned Account" and
 * "Why Accounts Get Banned" are compared rather than waved through as different.
 */
const FAILURE = new RegExp(
  `${TROUBLESHOOTING_SHAPE.source}|\\b(bans?|banned|restricted|flagged|blocked|limited)\\b|\\bno replies\\b`,
  "i"
);

/**
 * Two titles on one subject that are nonetheless different tasks: one is
 * troubleshooting and the other is not, one reverses what the other does, or
 * they are mirror tasks. The taxonomy asks for several article types per
 * subniche, so these must not be refused as duplicates of each other.
 */
function distinctTasks(a: string, b: string): boolean {
  if (FAILURE.test(a) !== FAILURE.test(b)) return true;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  // Whether a title reverses something at all — not which word it uses, or
  // delete/remove (synonyms) would count as different tasks.
  const reverses = (t: Set<string>) => [...t].some((w) => REVERSAL.has(w));
  if (reverses(ta) !== reverses(tb)) return true;
  for (const [x, y] of OPPOSITES) {
    if ((ta.has(x) && tb.has(y) && !ta.has(y) && !tb.has(x)) || (ta.has(y) && tb.has(x) && !ta.has(x) && !tb.has(y))) {
      return true;
    }
  }
  return false;
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

/** 0 (nothing in common, or different tasks) to 1 (same meaningful words). */
export function titleSimilarity(a: string, b: string): number {
  if (distinctTasks(a, b)) return 0;
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
  /**
   * Up to `k` existing titles closest to `candidate` scoring at least
   * `minScore`, most similar first — a shortlist for a closer (model) judgment.
   * Different-task titles are included on purpose: the task distinctions above
   * guard this module's own hard refusals, and the judge decides those pairs.
   */
  neighbors(candidate: string, k?: number, minScore?: number): string[];
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
        if (distinctTasks(candidate, e.title)) continue;
        const score = jaccard(tokens, e.tokens);
        if (score >= threshold && (!best || score > best.score)) best = { title: e.title, score };
      }
      return best?.title;
    },
    add(title) {
      entries.push({ title, tokens: titleTokens(title) });
    },
    neighbors(candidate, k = 5, minScore = 0.25) {
      const tokens = titleTokens(candidate);
      return entries
        .map((e) => ({ title: e.title, score: jaccard(tokens, e.tokens) }))
        .filter((e) => e.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((e) => e.title);
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
