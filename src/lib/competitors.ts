/**
 * Competitor brand names — shared across keyword research (research.ts) and
 * article generation (generator.ts).
 *
 * Add competitors here as they show up in Era data. This is the single source
 * of truth: research.ts uses it to filter pure-competitor topics, generator.ts
 * uses it to decide whether an article needs a web-search research pass for
 * accurate, current competitor facts.
 */
export const COMPETITORS = [
  "nreach",
  "enreach",
  "entergram",
  "vtiger",
  "hubspot",
  "zoho",
  "salesforce",
];

/**
 * True if the query mentions any competitor brand name (case-insensitive).
 */
export function namesCompetitor(query: string): boolean {
  const q = query.toLowerCase();
  return COMPETITORS.some((c) => q.includes(c));
}
