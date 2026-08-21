import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { searchKB, getKBArticle } from "./kb.js";
import { ANGLE_GUIDANCE } from "./taxonomy.js";
import { TITLE_RULES, TITLE_SHAPE_BY_ANGLE } from "./title-rules.js";
import { isPureCompetitorTopic } from "./research.js";
import { queryToSlug } from "../lib/utils.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

/**
 * How many already-covered topics to list in the prompt. Bounded so a growing
 * corpus cannot inflate the prompt without limit — at ~300 articles the full
 * list would dominate the context window.
 */
export const MAX_COVERED = 90;

export interface SeedResult {
  seeded: Array<{ query: string }>;
  skipped: number; // duplicates / competitor-filtered
  audience: string;
}

export interface SeederPromptInput {
  audience: string;
  /** Omitted for ad-hoc seeding from the plugin, where there is no rotation slot. */
  subniche?: string;
  angle?: string;
  kbContext: string;
  covered: string[];
  count: number;
}

/**
 * Build the user message for topic generation.
 *
 * The `covered` block is the anti-repetition mechanism. On a fixed rotation the
 * model will otherwise re-propose the same territory each cycle. Exact duplicate
 * queries are already rejected by insertSeededTopics, but NEAR-duplicates
 * ("Telegram CRM for crypto teams" vs "CRM for Web3 sales teams") pass straight
 * through and then compete with each other in search — so they have to be
 * prevented at generation time, not filtered afterwards.
 *
 * This is not hypothetical: the retired Era source produced 767 pending queries
 * that largely duplicated already-published articles.
 */
export function buildSeederPrompt(input: SeederPromptInput): string {
  const { audience, subniche, angle, kbContext, covered, count } = input;
  const trimmed = covered.slice(0, MAX_COVERED);

  const kbBlock = kbContext
    ? `\nCRMChat KNOWLEDGE BASE (ground topics in this — do not invent features):\n${kbContext}`
    : "\n(No specific KB context matched — propose tasks from what you know this audience does day to day in Telegram.)";

  const coveredBlock =
    trimmed.length > 0
      ? `\nALREADY COVERED — do NOT propose these, or close variations of them. Propose adjacent territory instead:\n${trimmed
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "";

  const subnicheLine = subniche ? `\nSUBNICHE — narrow every topic to this: ${subniche}` : "";
  // The bare angle word is ambiguous — "tops" would not, on its own, produce
  // "best X tools" topics — so ship its definition alongside it.
  const angleGuidance = angle ? ANGLE_GUIDANCE[angle] : undefined;
  const shape = angle ? TITLE_SHAPE_BY_ANGLE[angle] : undefined;
  const angleLine = angle
    ? `\nARTICLE TYPE — every title must be this type: ${angle}` +
      (angleGuidance ? `\n  (${angle} means: ${angleGuidance})` : "") +
      (shape ? `\n  REQUIRED TITLE SHAPE: ${shape}` : "")
    : "";
  const closing = [
    subniche ? `all within the "${subniche}" subniche` : null,
    angle ? `all of type "${angle}"` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return `TARGET AUDIENCE: ${audience}${subnicheLine}${angleLine}
${kbBlock}
${coveredBlock}

Propose ${count} article titles for this audience${closing ? `, ${closing}` : ""}. Each must be a task this audience genuinely has, NOT a topic about CRMChat. Call emit_topics.`;
}

/**
 * The exclusion list handed to the seeder: recent topic queries plus recently
 * published titles.
 *
 * Both matter. Queries catch territory already queued but not yet written;
 * titles catch territory already published. Without the titles the seeder
 * happily re-proposes something it wrote a month ago.
 */
export function getCoveredTopics(recentQueries = 60, recentTitles = 30): string[] {
  const db = getDb();
  const queries = db
    .prepare("SELECT query FROM keywords ORDER BY created_at DESC LIMIT ?")
    .all(recentQueries) as { query: string }[];
  const titles = db
    .prepare(
      "SELECT title FROM articles WHERE status = 'published' ORDER BY published_at DESC LIMIT ?"
    )
    .all(recentTitles) as { title: string }[];
  return [...queries.map((q) => q.query), ...titles.map((t) => t.title)];
}

export interface SeedOptions {
  /** Rotation slot, when seeding is driven by the scheduler. */
  niche?: string;
  subniche?: string;
  angle?: string;
  /** KB filenames pinned ahead of TF-IDF results — see Niche.kb_hints. */
  kbHints?: string[];
  /** Topics and titles already covered; excluded to prevent near-duplicates. */
  covered?: string[];
}

/**
 * Seed pending topics for a target audience, grounded in the knowledge base.
 *
 * Generates topic IDEAS from (a) an audience persona and (b) what CRMChat
 * actually does for that audience per the KB. Topics land as 'pending' with
 * source='seeded' and flow through the normal approve → generate pipeline.
 *
 * Called two ways: ad-hoc from the plugin (audience only), or by the scheduler
 * with a rotation slot (subniche + angle + kb_hints + covered).
 */
export async function seedTopics(
  audience: string,
  count: number = DEFAULT_COUNT,
  opts: SeedOptions = {}
): Promise<SeedResult> {
  const n = Math.min(Math.max(count, 1), MAX_COUNT);

  // 1. Assemble KB grounding. Pinned hints go first and are never displaced by
  //    relevance scoring — niches with thin keyword overlap (RU SaaS, currency
  //    exchanges) would otherwise retrieve noise and produce generic topics.
  const pinned = (opts.kbHints ?? [])
    .map((f) => getKBArticle(f))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  const pinnedNames = new Set(pinned.map((p) => p.filename));
  const searched = searchKB(`${audience} ${opts.subniche ?? ""}`.trim(), 5).filter(
    (r) => !pinnedNames.has(r.filename)
  );
  const kbResults = [...pinned, ...searched].slice(0, 5);

  const kbContext = kbResults
    .map((kb, i) => `--- KB ${i + 1}: ${kb.title} ---\n${kb.content.slice(0, 2000)}`)
    .join("\n\n");

  // 2. Generate candidate topics via Claude
  const candidates = await generateTopicCandidates({
    audience,
    subniche: opts.subniche,
    angle: opts.angle,
    kbContext,
    covered: opts.covered ?? [],
    count: n,
  });

  if (candidates.length === 0) {
    logger.warn({ audience }, "Seeder returned no candidate topics");
    return { seeded: [], skipped: 0, audience };
  }

  const { seeded, skipped, revived } = insertSeededTopics(candidates, opts.niche);
  logger.info(
    { audience, requested: n, seeded: seeded.length, revived, skipped },
    "Audience topic seeding complete"
  );
  return { seeded, skipped, audience };
}

/**
 * Insert a known list of topic phrases as pending 'seeded' keywords. Shared by
 * the audience generator (above) and the direct-import path (e.g. topics adapted
 * from an external blog). Seeded topics get a neutral default score (they have
 * no Era opportunity signal); the Topics queue floats source='seeded' to the top.
 *
 * Dedup behavior:
 *  - A query already present as pending/approved/generated → skip (genuinely active).
 *  - A query present only as a REJECTED row → revive it (status back to pending). A
 *    re-import of something you rejected means you want it back; reviving avoids
 *    leaving it stuck (the DELETE endpoint can't clear rejected rows) and avoids
 *    inserting a duplicate query row.
 *  - A query matching an existing article slug → skip (already written).
 *  - Otherwise → insert new.
 */
export function insertSeededTopics(
  candidates: string[],
  niche?: string
): { seeded: Array<{ query: string }>; skipped: number; revived: number } {
  const db = getDb();
  const SEEDED_SCORE = 50;

  // Map query -> {id, status}. If a query has multiple rows, prefer a non-rejected
  // one so we never revive when an active row already exists.
  const byQuery = new Map<string, { id: string; status: string }>();
  for (const row of db
    .prepare("SELECT id, query, status FROM keywords")
    .all() as Array<{ id: string; query: string; status: string }>) {
    const key = row.query.toLowerCase();
    const prev = byQuery.get(key);
    if (!prev || prev.status === "rejected") byQuery.set(key, { id: row.id, status: row.status });
  }
  const existingSlugs = new Set(
    (db.prepare("SELECT slug FROM articles").all() as { slug: string }[]).map(
      (r) => r.slug
    )
  );

  const toInsert: string[] = [];
  const toRevive: string[] = []; // keyword ids
  const seededQueries: string[] = [];
  const seenInBatch = new Set<string>();
  let skipped = 0;

  for (const raw of candidates) {
    const query = (raw ?? "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    const slug = queryToSlug(query);

    if (seenInBatch.has(key)) { skipped++; continue; }
    seenInBatch.add(key);

    if (isPureCompetitorTopic(query) || existingSlugs.has(slug)) {
      skipped++;
      continue;
    }

    const existing = byQuery.get(key);
    if (existing) {
      if (existing.status === "rejected") {
        toRevive.push(existing.id);
        seededQueries.push(query);
      } else {
        skipped++; // pending / approved / generated — genuinely active
      }
      continue;
    }

    toInsert.push(query);
    seededQueries.push(query);
  }

  const insertStmt = db.prepare(
    `INSERT INTO keywords (id, query, source, opportunity_score, status, niche)
     VALUES (?, ?, 'seeded', ?, 'pending', ?)`
  );
  // Revive must set `niche` too. Writing it only on the INSERT path meant a
  // previously-rejected topic revived by a probationary niche kept a NULL or
  // stale niche, so the probation filter never matched it and it could
  // generate unattended — the exact leak probation exists to prevent.
  const reviveStmt = db.prepare(
    `UPDATE keywords SET status = 'pending', source = 'seeded', opportunity_score = ?, niche = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const insertMany = db.transaction((items: string[]) => {
    for (const q of items) insertStmt.run(nanoid(), q, SEEDED_SCORE, niche ?? null);
    for (const id of toRevive) reviveStmt.run(SEEDED_SCORE, niche ?? null, id);
  });
  if (toInsert.length > 0 || toRevive.length > 0) insertMany(toInsert);

  return {
    seeded: seededQueries.map((query) => ({ query })),
    skipped,
    revived: toRevive.length,
  };
}

async function generateTopicCandidates(input: SeederPromptInput): Promise<string[]> {
  const { audience, count } = input;
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    // Sonnet 5 defaults to adaptive thinking; disable to preserve 4.6 behavior
    // (forced tool_choice below + fixed token budget).
    thinking: { type: "disabled" },
    max_tokens: 2048,
    tools: [
      {
        name: "emit_topics",
        description: "Emit the list of proposed article topic titles.",
        input_schema: {
          type: "object" as const,
          properties: {
            topics: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Array of finished article titles, one per element.",
            },
          },
          required: ["topics"],
        },
      },
    ],
    tool_choice: { type: "tool" as const, name: "emit_topics" },
    system: `You propose ARTICLE TITLES for the CRMChat blog. CRMChat is a Telegram-native CRM and outreach platform for sales teams.

The blog is a long-tail task library, modelled on how NinjaOne writes for IT admins: articles answer a specific job the reader is trying to do, and the product is introduced inside the article where it genuinely helps. The titles are the search queries, stated plainly.

WHAT TO WRITE ABOUT — ADJACENT TASKS, NOT PRODUCT FEATURES:
- Propose the practical jobs this audience actually has around Telegram, outreach and sales operations. Someone typing that task into Google or asking an AI assistant should land here.
- The topic must NOT be about CRMChat. Do not propose "CRM for X", "best Telegram CRM", or anything whose subject is the product. CRMChat gets introduced in the BODY, as one way to do the task.
- A good test: would this article still be useful to someone who never buys anything? If no, it is too product-led.
  GOOD: "How to Export Telegram Group Members to CSV"
  GOOD: "Why Telegram Accounts Get Banned for Bulk Messaging"
  GOOD: "What Is a Telegram Session String"
  BAD:  "Multi-account Telegram CRM for OnlyFans agencies"   (subject is the product)
  BAD:  "Best CRM for crypto funds"                          (subject is the product)
- Stay inside the audience's world. These are tasks THIS cohort does — not unrelated general business advice.
- Use the knowledge base to understand what this audience does and what is genuinely true about Telegram, so the task is real and the eventual article can be accurate. Do not let the KB pull the topic toward being about CRMChat.

${TITLE_RULES}

- Each title must be a DIFFERENT task. Do not propose near-variations of one another.
- Do not propose pure-competitor titles (a competitor name with no task behind it).

Return exactly ${count} titles via the emit_topics tool.`,
    messages: [
      {
        role: "user",
        content: buildSeederPrompt(input),
      },
    ],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    logger.error(
      { audience, stopReason: response.stop_reason },
      "Seeder: Claude did not return tool_use block"
    );
    return [];
  }
  const out = (toolBlock.input as { topics?: unknown }).topics;
  if (!Array.isArray(out)) return [];
  return out.filter((t): t is string => typeof t === "string");
}
