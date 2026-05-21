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

  // 3. Dedup against existing keywords + slugs, drop pure-competitor topics
  const existingQueries = new Set(
    (db.prepare("SELECT query FROM keywords").all() as { query: string }[]).map(
      (r) => r.query.toLowerCase()
    )
  );
  const existingSlugs = new Set(
    (db.prepare("SELECT slug FROM articles").all() as { slug: string }[]).map(
      (r) => r.slug
    )
  );

  const toInsert: string[] = [];
  let skipped = 0;

  for (const raw of candidates) {
    const query = raw.trim();
    if (!query) continue;
    const key = query.toLowerCase();
    const slug = queryToSlug(query);

    if (existingQueries.has(key) || existingSlugs.has(slug)) {
      skipped++;
      continue;
    }
    if (isPureCompetitorTopic(query)) {
      skipped++;
      continue;
    }

    existingQueries.add(key);
    existingSlugs.add(slug);
    toInsert.push(query);
  }

  // 4. Insert. Seeded topics get a neutral default score so they sort alongside
  //    Era topics in the pending queue (they have no Era opportunity signal).
  const SEEDED_SCORE = 50;
  const insertStmt = db.prepare(
    `INSERT INTO keywords (id, query, source, opportunity_score, status)
     VALUES (?, ?, 'seeded', ?, 'pending')`
  );
  const insertMany = db.transaction((items: string[]) => {
    for (const q of items) insertStmt.run(nanoid(), q, SEEDED_SCORE);
  });
  if (toInsert.length > 0) insertMany(toInsert);

  logger.info(
    { audience, requested: n, seeded: toInsert.length, skipped },
    "Audience topic seeding complete"
  );

  return {
    seeded: toInsert.map((query) => ({ query })),
    skipped,
    audience,
  };
}

async function generateTopicCandidates(
  audience: string,
  kbContext: string,
  count: number
): Promise<string[]> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
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
