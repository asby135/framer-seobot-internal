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

export const ANGLES = [
  "how-to",
  "comparison",
  "migration",
  "troubleshooting",
  "pricing",
] as const;

function rotatable(niches: Niche[]): Niche[] {
  return niches.filter((n) => !n.probation && n.subniches.length > 0);
}

/** Total rotation slots available across all non-probationary niches. */
export function countSlots(niches: Niche[]): number {
  return rotatable(niches).reduce((n, x) => n + x.subniches.length * ANGLES.length, 0);
}

/**
 * Resolve a cursor to a concrete (niche, subniche, angle) slot.
 *
 * The order is stable — niche, then subniche, then angle — so a persisted
 * cursor keeps its meaning across restarts. Returns null when nothing is
 * rotatable (every niche on probation, or no subniches configured), which the
 * caller must treat as "skip seeding tonight" rather than an error.
 */
export function nextSlot(niches: Niche[], cursor: number): Slot | null {
  const active = rotatable(niches);
  if (active.length === 0) return null;

  const total = countSlots(active);
  // Normalise into range, tolerating a negative or wrapped cursor.
  const idx = ((cursor % total) + total) % total;

  let seen = 0;
  for (const niche of active) {
    for (const subniche of niche.subniches) {
      for (const angle of ANGLES) {
        if (seen === idx) return { niche, subniche, angle, cursor: cursor + 1 };
        seen++;
      }
    }
  }
  /* c8 ignore next */
  return null; // unreachable: idx < total
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
