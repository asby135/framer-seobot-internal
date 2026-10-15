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

/** Remove and return one item at random. `items` must be non-empty. */
function take<T>(items: T[], rng: () => number): T {
  // Clamp: an rng returning exactly 1 would otherwise index out of bounds.
  const i = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items.splice(i, 1)[0];
}

/**
 * Draw up to `count` distinct topics, dealt round-robin across niches.
 *
 * Each lap visits every niche that still has topics once, in a fresh random
 * order, taking one random topic from it. So no niche gets a second topic until
 * every niche has had a first, and which niche gets the odd extra slot changes
 * from night to night instead of favouring whichever sorts first.
 *
 * A uniform draw was not enough. One seed writes a batch of sibling titles for
 * a single subniche, and the unoffered pool is dominated by the latest seed or
 * two — so a uniform draw put three takes on one subject in a single digest
 * while the blog as a whole looked balanced.
 *
 * Topics with no niche (hand-entered, or predating the column) form one group
 * of their own: they neither crowd out the niches nor get starved by them.
 */
function drawSpread(pool: PendingTopic[], count: number, rng: () => number): PendingTopic[] {
  const byNiche = new Map<string, PendingTopic[]>();
  for (const t of pool) {
    const key = t.niche ?? "";
    const group = byNiche.get(key);
    if (group) group.push(t);
    else byNiche.set(key, [t]);
  }

  const picked: PendingTopic[] = [];
  while (picked.length < count && byNiche.size > 0) {
    const lap = [...byNiche.keys()];
    while (picked.length < count && lap.length > 0) {
      const key = take(lap, rng);
      const group = byNiche.get(key)!;
      picked.push(take(group, rng));
      if (group.length === 0) byNiche.delete(key);
    }
  }
  return picked;
}

/**
 * Pick up to `count` topics at random from the usable pool, preferring ones the
 * operator has not already been shown.
 *
 * Random rather than scored: with Era gone every seeded topic carries the same
 * neutral opportunity_score, so ranking would be meaningless. The draw is dealt
 * round-robin across niches — see drawSpread — because randomness alone did
 * not spread a night: it follows the pool, and the pool is lumpy.
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

  const picked = drawSpread(unoffered, count, rng);
  if (picked.length < count) picked.push(...drawSpread(offered, count - picked.length, rng));
  return picked;
}

/**
 * Should the seeder run tonight?
 *
 * Counts the topics selection could actually propose: a usable source, not yet
 * offered at gate 1, and not from a probationary niche.
 *
 * Offered topics are excluded because they are not runway. Counting them
 * deadlocked the pipeline once: a queue of proposed-but-ignored topics sat
 * above the threshold, the seeder never ran, and the rotation cursor froze.
 *
 * Probationary topics are excluded for the same reason — selection never picks
 * them, so they cannot fill a night. Counting them stalled the digest outright:
 * with a few niches on probation the unoffered pool filled with topics nothing
 * could select, seeding stopped, and every night after that sent nothing. That
 * they used to be counted was a guard against seeding forever when every niche
 * is on probation; that guard now lives in the top-up loop, which stops
 * seeding a probationary niche once it has a sample waiting for review.
 */
export function needsTopUp(
  topics: PendingTopic[],
  threshold: number,
  excludeNiches: Set<string> = new Set()
): boolean {
  return usableTopics(topics, excludeNiches).filter((t) => !alreadyOffered(t)).length < threshold;
}

/** Unoffered usable topics from one niche — its sample awaiting review. */
export function unofferedInNiche(topics: PendingTopic[], niche: string): number {
  return usableTopics(topics).filter((t) => t.niche === niche && !alreadyOffered(t)).length;
}

/**
 * How many unoffered topics the top-up should maintain.
 *
 * The configured threshold, but never less than two of the largest nights. The
 * floor is about variety, not about running dry: a night can only be as varied
 * as the pool it is dealt from, and a pool one night deep holds two or three
 * seeds — two or three niches — no matter how fairly selectTopics deals it.
 * Two nights deep, the pool carries leftovers from enough earlier slots that a
 * night reaches most of the taxonomy.
 */
export function poolTarget(configuredThreshold: number, maxPerNight: number): number {
  return Math.max(configuredThreshold, 2 * maxPerNight);
}
