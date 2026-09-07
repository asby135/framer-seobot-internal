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
  /**
   * The headline this topic was last offered under at gate 1, or null/absent if
   * it has never been in a digest.
   *
   * Gate 1 does not consume a topic — it stays `pending` until the operator
   * approves or rejects it — so this is the only record that it has already
   * been put in front of them.
   */
  proposedTitle?: string | null;
}

/** Has this topic already been offered to the operator in a digest? */
function alreadyOffered(t: PendingTopic): boolean {
  return Boolean(t.proposedTitle);
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

/** Draw up to `count` distinct items at random, consuming `pool`. */
function draw(pool: PendingTopic[], count: number, rng: () => number): PendingTopic[] {
  const picked: PendingTopic[] = [];
  while (picked.length < count && pool.length > 0) {
    // Clamp: an rng returning exactly 1 would otherwise index out of bounds.
    const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

/**
 * Pick up to `count` topics at random from the usable pool, preferring ones the
 * operator has not already been shown.
 *
 * Random rather than scored: with Era gone every seeded topic carries the same
 * neutral opportunity_score, so ranking would be meaningless. Randomness also
 * spreads output across niches within a night.
 *
 * The unoffered-first rule is not a nicety. Gate 1 leaves a topic `pending`, so
 * without it every night re-sampled the whole standing queue: topics nobody had
 * acted on came round again and again while the rest of the queue was never
 * proposed at all, and the digest read as three or four subjects on repeat.
 *
 * Previously-offered topics are still used to fill out a short night rather
 * than sending a thin or empty digest — a repeat the operator can ignore beats
 * silence they cannot interpret.
 */
export function selectTopics(
  topics: PendingTopic[],
  count: number,
  rng: () => number = Math.random,
  excludeNiches: Set<string> = new Set()
): PendingTopic[] {
  const pool = usableTopics(topics, excludeNiches); // fresh array; caller unmutated
  const unoffered = pool.filter((t) => !alreadyOffered(t));
  const offered = pool.filter(alreadyOffered);

  const picked = draw(unoffered, count, rng);
  if (picked.length < count) picked.push(...draw(offered, count - picked.length, rng));
  return picked;
}

/**
 * Should the seeder run tonight?
 *
 * Counts every topic with a usable SOURCE that has NOT already been offered at
 * gate 1, including ones from probationary niches: those are real topics
 * sitting in the queue awaiting review, so they fill the pool. Only selection
 * excludes them. Deliberately takes no exclusion set — passing one here
 * reintroduced unbounded nightly seeding, because with every niche on probation
 * the pool never looked full.
 *
 * Offered topics are excluded because they are not runway. Counting them
 * deadlocked the pipeline: a topic proposed at gate 1 stays `pending` until the
 * operator acts, so a queue of proposed-but-ignored topics sat permanently
 * above the threshold, the seeder never ran again, and the rotation cursor —
 * the only thing that moves the seeder onto a new niche, subniche and angle —
 * never advanced. The pool froze at whatever the last few slots produced.
 */
export function needsTopUp(topics: PendingTopic[], threshold: number): boolean {
  return usableTopics(topics).filter((t) => !alreadyOffered(t)).length < threshold;
}
