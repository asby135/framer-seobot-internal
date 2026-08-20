/**
 * The topic taxonomy: niche → subniche → angle.
 *
 * Rotation walks all three levels so the seeder never revisits the same ground
 * until it has exhausted the space. With 8 niches × ~6 subniches × 5 angles the
 * pipeline has ~240 slots, or roughly a year of non-repeating topics at 10
 * topics per seed and 5-10 articles a night. A flat niche-only rotation would
 * cycle in about a month.
 *
 * Everything here is pure — no DB, no network — so the rotation logic is
 * verifiable without standing anything up.
 */

export interface Niche {
  name: string;
  /**
   * A persona SENTENCE, not a label. `seedTopics` grounds topics on
   * `searchKB(audience)`, so lexical overlap with the industry page is what
   * retrieves useful context. "Web3" pulls noise; a full sentence pulls the page.
   */
  persona: string;
  subniches: string[];
  /** KB filenames force-included as grounding, ahead of TF-IDF matches. */
  kb_hints: string[];
  /**
   * Probationary niches are still seeded — their topics land as `pending` for
   * manual review — but are excluded from automatic selection until the
   * operator has seen what they produce.
   */
  probation: boolean;
}

export interface Slot {
  niche: Niche;
  subniche: string;
  angle: string;
  /** The cursor to persist so rotation survives a restart. Always monotonic. */
  cursor: number;
}

/**
 * Article-type mix, as percentages.
 *
 * These mirror the five archetypes in the generator's ARTICLE TYPE rules, and
 * the proportions are the observed distribution of what actually earns traffic:
 * how-to dominates, what-is is short and cheap, comparisons are rare but
 * hottest-intent, listicles rarest.
 *
 * Weighting matters because the generator classifies each keyword into an
 * archetype and applies that archetype's structure — but nothing controlled the
 * MIX. An even rotation produced ~20% comparisons against a 4% target and no
 * what-is topics at all, so the format rules were being fed the wrong supply.
 */
export const ANGLE_WEIGHTS: Record<string, number> = {
  "how-to": 67,
  "what-is": 13,
  troubleshooting: 15,
  comparison: 4,
  tops: 1,
};

export const ANGLES = Object.keys(ANGLE_WEIGHTS);

/**
 * What each angle means, in seeder terms.
 *
 * The bare word is ambiguous — "tops" alone would not tell the model to propose
 * "best X tools" topics — and the angle string is injected straight into the
 * prompt, so it has to carry its own definition.
 */
export const ANGLE_GUIDANCE: Record<string, string> = {
  "how-to":
    "practical, step-by-step topics solving one specific technical pain — phrased like \"how to X\", \"X setup\", \"X workflow\"",
  "what-is":
    "definitional topics explaining a single concept — phrased like \"what is X\", \"X explained\", \"X meaning\"",
  troubleshooting:
    "failure-mode topics — something broken, blocked or misbehaving, phrased like \"X not working\", \"fix X\", \"why X gets banned\"",
  comparison:
    "evaluation topics weighing options — phrased like \"X vs Y\", \"X alternatives\", \"best X for Y\"",
  tops:
    "roundup topics surveying a category — phrased like \"best X tools\", \"top X for Y\"",
};

/**
 * Expand weights into a schedule with one entry per weight unit, interleaved so
 * no angle appears in a long block.
 *
 * Interleaving is the point: emitting 67 how-to slots and only then reaching
 * variety would mean months of identical output before the first comparison.
 * Each step picks whichever angle is furthest behind its target share, which
 * spreads rare angles evenly instead of clumping them at the end.
 */
export function buildAngleSchedule(weights: Record<string, number>): string[] {
  const angles = Object.keys(weights);
  const total = angles.reduce((sum, a) => sum + weights[a], 0);
  const emitted: Record<string, number> = Object.fromEntries(angles.map((a) => [a, 0]));
  const out: string[] = [];

  for (let i = 1; i <= total; i++) {
    let best = angles[0];
    let bestDeficit = -Infinity;
    for (const a of angles) {
      const deficit = (weights[a] * i) / total - emitted[a];
      if (deficit > bestDeficit) {
        best = a;
        bestDeficit = deficit;
      }
    }
    out.push(best);
    emitted[best] += 1;
  }

  return out;
}

/** The live schedule, indexed by the rotation cursor. */
export const ANGLE_SCHEDULE = buildAngleSchedule(ANGLE_WEIGHTS);

function rotatable(niches: Niche[]): Niche[] {
  return niches.filter((n) => !n.probation && n.subniches.length > 0);
}

/** Distinct (niche, subniche) pairs available for rotation. */
export function countPairs(niches: Niche[]): number {
  return rotatable(niches).reduce((n, x) => n + x.subniches.length, 0);
}

/**
 * Distinct (niche, subniche, angle) combinations — the non-repeating runway.
 * The angle SCHEDULE governs how often each angle comes up; this counts how
 * much distinct ground exists.
 */
export function countSlots(niches: Niche[]): number {
  return countPairs(niches) * ANGLES.length;
}

/**
 * Resolve a cursor to a concrete (niche, subniche, angle) slot.
 *
 * Niche/subniche advance one step per seeding; the angle is drawn from the
 * weighted schedule. Two different moduli means the pair and the angle drift
 * against each other, so a given subniche is not permanently welded to one
 * angle — over time each subniche is approached from every angle, in the target
 * proportions.
 *
 * Returns null when nothing is rotatable (every niche on probation, or none
 * configured), which the caller treats as "skip seeding tonight", not an error.
 */
export function nextSlot(niches: Niche[], cursor: number): Slot | null {
  const active = rotatable(niches);
  if (active.length === 0) return null;

  const pairs = countPairs(active);
  if (pairs === 0) return null;

  // Normalise, tolerating a negative or wrapped cursor.
  const pairIdx = ((cursor % pairs) + pairs) % pairs;
  const angleIdx =
    ((cursor % ANGLE_SCHEDULE.length) + ANGLE_SCHEDULE.length) % ANGLE_SCHEDULE.length;
  const angle = ANGLE_SCHEDULE[angleIdx];

  let seen = 0;
  for (const niche of active) {
    for (const subniche of niche.subniches) {
      if (seen === pairIdx) return { niche, subniche, angle, cursor: cursor + 1 };
      seen++;
    }
  }
  /* c8 ignore next */
  return null; // unreachable: pairIdx < pairs
}

/**
 * The eight agreed niches. The first five have industry pages and case studies
 * in knowledge/; the last three have thin or no KB coverage and start on
 * probation so their first batches get reviewed before they enter rotation.
 */
export const DEFAULT_NICHES: Niche[] = [
  {
    name: "Web3 / crypto",
    persona:
      "Web3 BD leads at DeFi protocols and crypto funds running partnership outreach on Telegram",
    subniches: [
      "DeFi protocols",
      "crypto funds and VCs",
      "token launchpads",
      "NFT and gaming studios",
      "conference and event teams",
      "market makers",
    ],
    kb_hints: ["industry-web3-crypto.md", "product-web3-database.md"],
    probation: false,
  },
  {
    name: "B2B lead-gen agencies",
    persona:
      "B2B lead generation agency owners delivering Telegram outreach as a service for client campaigns",
    subniches: [
      "boutique agencies",
      "enterprise GTM firms",
      "SaaS-focused agencies",
      "appointment setting teams",
      "white-label providers",
      "freelance SDRs",
    ],
    kb_hints: ["industry-leadgen-agencies.md", "case-study-lead-sniper.md"],
    probation: false,
  },
  {
    name: "iGaming affiliates",
    persona:
      "iGaming affiliate managers driving casino and betting FTDs from Meta traffic into Telegram",
    subniches: [
      "casino affiliates",
      "sportsbook affiliates",
      "traffic networks",
      "affiliate program managers",
      "media buying teams",
      "VIP player managers",
    ],
    kb_hints: ["industry-igaming.md"],
    probation: false,
  },
  {
    name: "Creator / OnlyFans agencies",
    persona:
      "Content creator agency operators managing multiple model accounts, chatters and PPV sales in Telegram DMs",
    subniches: [
      "model management agencies",
      "chatter teams",
      "PPV sales operations",
      "fan migration from other platforms",
      "solo creators scaling up",
      "agency owners hiring chatters",
    ],
    kb_hints: ["creator-agency-telegram.md", "product-ppv-bot.md"],
    probation: false,
  },
  {
    name: "Media buying",
    persona:
      "Media buying providers finding and closing media buyers through Telegram communities",
    subniches: [
      "performance agencies",
      "traffic arbitrage teams",
      "ad network sales",
      "affiliate media buyers",
      "in-house growth teams",
      "creative studios",
    ],
    kb_hints: ["industry-media-buying.md"],
    probation: false,
  },
  {
    name: "RU B2B SaaS",
    persona:
      "Russian-speaking B2B SaaS founders and sales leads finding decision-makers across RU and CIS where LinkedIn is unavailable",
    subniches: [
      "HR tech",
      "fintech SaaS",
      "logistics and supply chain",
      "martech",
      "edtech",
      "devtools",
    ],
    kb_hints: ["finding-decision-makers-ru-cis.md", "product-lead-research.md"],
    probation: true,
  },
  {
    name: "RU AI companies",
    persona:
      "Russian-speaking AI product teams and integrators selling automation services to businesses over Telegram",
    subniches: [
      "AI integrators",
      "chatbot studios",
      "ML consultancies",
      "AI SaaS products",
      "automation agencies",
      "no-code AI builders",
    ],
    kb_hints: ["finding-decision-makers-ru-cis.md", "telegram-ai-sales-agent.md"],
    probation: true,
  },
  {
    name: "Online currency exchanges",
    persona:
      "Operators of online currency and crypto exchange desks handling client trades and support entirely in Telegram",
    subniches: [
      "P2P exchange desks",
      "crypto-fiat exchangers",
      "forex signal desks",
      "OTC trading desks",
      "payment rail operators",
      "regional exchange networks",
    ],
    kb_hints: ["industry-web3-crypto.md", "product-telegram-crm.md"],
    probation: true,
  },
];
