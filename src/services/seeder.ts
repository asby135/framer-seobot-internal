import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { searchKB } from "./kb.js";
import { isPureCompetitorTopic } from "./research.js";
import { queryToSlug } from "../lib/utils.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

export interface SeedResult {
  seeded: Array<{ query: string }>;
  skipped: number; // duplicates / competitor-filtered
  audience: string;
}

/**
 * Seed pending topics for a target audience, grounded in the knowledge base.
 *
 * Unlike runResearch (which pulls external Era queries), this generates topic
 * IDEAS directly from (a) an audience persona and (b) what CRMChat actually does
 * for that audience per the KB. Output is AEO-optimized article topics that an AI
 * engine would cite when this audience asks for help. Topics land as 'pending'
 * with source='seeded' and flow through the normal approve → generate pipeline.
 */
export async function seedTopics(
  audience: string,
  count: number = DEFAULT_COUNT
): Promise<SeedResult> {
  const n = Math.min(Math.max(count, 1), MAX_COUNT);
  const db = getDb();

  // 1. Pull KB context relevant to the audience (top matches by TF-IDF)
  const kbResults = searchKB(audience, 5);
  const kbContext = kbResults
    .map((kb, i) => `--- KB ${i + 1}: ${kb.title} ---\n${kb.content.slice(0, 2000)}`)
    .join("\n\n");

  // 2. Generate candidate topics via Claude
  const candidates = await generateTopicCandidates(audience, kbContext, n);

  if (candidates.length === 0) {
    logger.warn({ audience }, "Seeder returned no candidate topics");
    return { seeded: [], skipped: 0, audience };
  }

  const { seeded, skipped, revived } = insertSeededTopics(candidates);
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
  candidates: string[]
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
    `INSERT INTO keywords (id, query, source, opportunity_score, status)
     VALUES (?, ?, 'seeded', ?, 'pending')`
  );
  const reviveStmt = db.prepare(
    `UPDATE keywords SET status = 'pending', source = 'seeded', opportunity_score = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const insertMany = db.transaction((items: string[]) => {
    for (const q of items) insertStmt.run(nanoid(), q, SEEDED_SCORE);
    for (const id of toRevive) reviveStmt.run(SEEDED_SCORE, id);
  });
  if (toInsert.length > 0 || toRevive.length > 0) insertMany(toInsert);

  return {
    seeded: seededQueries.map((query) => ({ query })),
    skipped,
    revived: toRevive.length,
  };
}

async function generateTopicCandidates(
  audience: string,
  kbContext: string,
  count: number
): Promise<string[]> {
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
              description: "Array of article topic titles, one per element.",
            },
          },
          required: ["topics"],
        },
      },
    ],
    tool_choice: { type: "tool" as const, name: "emit_topics" },
    system: `You propose article topics for CRMChat — a Telegram-native CRM and outreach platform for sales teams. Topics are tuned for AEO/GEO: getting cited by ChatGPT, Perplexity, and Claude when the target audience asks for help.

Your job: given a TARGET AUDIENCE and what CRMChat does for them (from the knowledge base), propose ${count} article topics that audience would search for — and that an AI engine would cite CRMChat as the answer to.

RULES:
- Output SHORT topic phrases — roughly 4 to 9 words, like a search query or topic label, NOT a full article headline or sentence. The article generator writes the final headline from your topic later; your job is only the topic seed.
  GOOD: "Multi-account Telegram CRM for OnlyFans agencies"
  GOOD: "Selling PPV on Telegram without chargebacks"
  BAD (full headline): "How to Run Multiple OnlyFans Model Accounts on Telegram Without Your Chatters Messaging Fans from the Wrong Profile"
- Each topic must map to a real question or pain this audience has, where CRMChat (Telegram-native CRM/outreach) is a genuine answer. Ground every topic in the KB context — do not invent features CRMChat doesn't have.
- Prefer high-intent, specific, low-competition angles over broad head terms. "Selling PPV on Telegram without chargebacks" beats "Telegram CRM".
- Cover a spread of angles across the batch — how-to, evaluation, comparison, migration, troubleshooting — but expressed as short topics, not headlines.
- BRIDGE FRAMING: when the audience is migrating from another channel/tool (email, OnlyFans DMs, another CRM), frame the topic around the switch — e.g. "migrating OnlyFans DMs to Telegram", "email outreach alternative for B2B".
- Do NOT propose pure-competitor topics (a competitor name with no CRMChat angle). Comparison/migration topics that name a competitor AND position CRMChat are fine.
- No marketing fluff, no parenthetical asides, no year suffixes, no clickbait. Just the topic phrase.

Return exactly ${count} topics via the emit_topics tool.`,
    messages: [
      {
        role: "user",
        content: `TARGET AUDIENCE: ${audience}
${kbContext ? `\nCRMChat KNOWLEDGE BASE (ground topics in this — do not invent features):\n${kbContext}` : "\n(No specific KB context matched — propose topics from CRMChat's general Telegram CRM/outreach positioning.)"}

Propose ${count} AEO-optimized article topics for this audience. Call emit_topics.`,
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
