/**
 * Opportunity scoring for GSC keywords.
 *
 * Formula: score = impressions * (1 - CTR) * position_weight(position)
 *
 * position_weight favors the "underserved sweet spot" where a new article
 * has the highest ROI:
 *   - Position 1-3:   0.1 (already winning, low priority)
 *   - Position 4-10:  0.5 (page 1 but not top, medium opportunity)
 *   - Position 11-30: 1.0 (page 2-3, highest opportunity)
 *   - Position 31+:   0.3 (too far back to compete easily)
 */

interface ScoringInput {
  impressions: number;
  ctr: number;
  position: number;
}

export function positionWeight(position: number): number {
  // Guard: clamp to valid range
  const pos = Math.max(1, position);

  if (pos <= 3) return 0.1;
  if (pos <= 10) return 0.5;
  if (pos <= 30) return 1.0;
  return 0.3;
}

export function calculateOpportunityScore(input: ScoringInput): number {
  // Sanitize inputs per TODOS.md
  const impressions = Math.max(0, input.impressions);
  const ctr = Math.max(0, Math.min(1, input.ctr)); // Clamp to [0, 1]
  const weight = positionWeight(input.position);

  return impressions * (1 - ctr) * weight;
}
