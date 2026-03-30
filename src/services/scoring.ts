/**
 * Opportunity scoring for GSC keywords.
 *
 * Formula: score = impressions * (1 - CTR) * position_weight(position)
 *
 * position_weight favors the "underserved sweet spot" where a new article
 * has the highest ROI:
 *   - Position 1-5:   0.05 (already winning, very low priority)
 *   - Position 6-10:  0.2  (page 1 but not top, low-medium opportunity)
 *   - Position 11-30: 1.0  (page 2-3, highest opportunity — a new article can push to page 1)
 *   - Position 31+:   0.3  (too far back to compete easily)
 */

interface ScoringInput {
  impressions: number;
  ctr: number;
  position: number;
}

export function positionWeight(position: number): number {
  const pos = Math.max(1, position);

  if (pos <= 5) return 0.05;
  if (pos <= 10) return 0.2;
  if (pos <= 30) return 1.0;
  return 0.3;
}

export function calculateOpportunityScore(input: ScoringInput): number {
  const impressions = Math.max(0, input.impressions);
  const ctr = Math.max(0, Math.min(1, input.ctr));
  const weight = positionWeight(input.position);

  return impressions * (1 - ctr) * weight;
}

/**
 * Check if a query is in English (no Cyrillic characters).
 * Used to filter out non-English queries for the English blog.
 */
export function isEnglishQuery(query: string): boolean {
  return !/[\u0400-\u04FF]/.test(query);
}
