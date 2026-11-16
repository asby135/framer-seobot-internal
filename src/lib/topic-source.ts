/**
 * Where a topic came from, as far as the operator needs to see it.
 *
 * `serpstat` marks topics adapted from competitor posts found through Serpstat
 * and competitor sitemaps. They go through the same gates as seeded topics; the
 * operator asked to see them tagged in the Telegram digests so it is clear which
 * articles the competitor research produced.
 */
export const SERPSTAT_SOURCE = "serpstat";

/** Sources an operator or script may assign to a topic it adds or re-tags. */
export const ASSIGNABLE_SOURCES = new Set(["seeded", "custom", SERPSTAT_SOURCE]);

/** Suffix shown after a title in Telegram, e.g. " (Serpstat)"; empty for ordinary topics. */
export function sourceTag(source: string | null | undefined): string {
  return source === SERPSTAT_SOURCE ? " (Serpstat)" : "";
}
