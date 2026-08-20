/**
 * Which pending topics become tonight's articles.
 *
 * Pure functions with an injected RNG so selection is deterministic under test.
 */

export interface PendingTopic {
  id: string;
  query: string;
  source: string;
  /** Taxonomy niche that seeded it, when known. */
  niche?: string | null;
}

/**
 * Era/OhMyGEO was retired: its queries largely duplicated already-published
 * articles, and 770 such rows were purged on 2026-08-19. Only self-seeded and
 * hand-entered topics are eligible.
 *
 * This is an allowlist rather than a denylist so an unrecognised source fails
 * closed — a new source must be added here deliberately before it can consume
 * generation budget.
 */
const USABLE_SOURCES = new Set(["seeded", "custom"]);

/**
 * Topics eligible for automatic selection.
 *
 * `excludeNiches` holds probationary niches: their topics are seeded and
 * visible in the queue, but must not generate unattended until the operator has
 * approved some by hand.
 */
export function usableTopics(
  topics: PendingTopic[],
  excludeNiches: Set<string> = new Set()
): PendingTopic[] {
  return topics.filter(
    (t) => USABLE_SOURCES.has(t.source) && !(t.niche && excludeNiches.has(t.niche))
  );
}

/**
 * Pick up to `count` topics at random from the usable pool.
 *
 * Random rather than scored: with Era gone every seeded topic carries the same
 * neutral opportunity_score, so ranking would be meaningless. Randomness also
 * spreads output across niches within a night.
 */
export function selectTopics(
  topics: PendingTopic[],
  count: number,
  rng: () => number = Math.random,
  excludeNiches: Set<string> = new Set()
): PendingTopic[] {
  const pool = usableTopics(topics, excludeNiches); // fresh array; caller unmutated
  const picked: PendingTopic[] = [];

  while (picked.length < count && pool.length > 0) {
    // Clamp: an rng returning exactly 1 would otherwise index out of bounds.
    const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    picked.push(pool.splice(i, 1)[0]);
  }

  return picked;
}

/**
 * Should the seeder run tonight?
 *
 * Counts every topic with a usable SOURCE, including ones from probationary
 * niches: those are real topics sitting in the queue awaiting review, so they
 * fill the pool. Only selection excludes them. Deliberately takes no
 * exclusion set — passing one here reintroduced unbounded nightly seeding,
 * because with every niche on probation the pool never looked full.
 */
export function needsTopUp(topics: PendingTopic[], threshold: number): boolean {
  return usableTopics(topics).length < threshold;
}
