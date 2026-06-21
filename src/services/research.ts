import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { fetchEraQueries } from "./era.js";
import { namesCompetitor } from "../lib/competitors.js";
import { queryToSlug } from "../lib/utils.js";
import { logger } from "../lib/logger.js";

// Skip Era queries with raw mention count below this threshold. opportunity_score
// is now the raw Era count (see era.ts), so this drops low-volume queries — rough
// "fewer than ~30 mentions in AI conversations" cutoff. Tune freely; lower keeps
// more long-tail topics, higher focuses on Era's top tier.
const ERA_SCORE_FILTER = 5;

// Task/integration signals. If a competitor-named topic also contains one of
// these, it's a how-to / pain-point topic (e.g. "Vtiger Telegram integration
// setup guide") where CRMChat's Telegram-native nature is a genuine reframe —
// keep it. NOTE: "telegram" and "bot" are intentionally excluded — nearly every
// query in this dataset contains them, so they're useless as a distinguishing
// signal.
const TASK_SIGNALS = [
  "integration",
  "integrate",
  "setup",
  "set up",
  "connect",
  "sync",
  "automate",
  "automation",
  "how to",
  "guide",
  "tutorial",
  "api",
  "webhook",
];

/**
 * A "pure competitor" topic names a competitor, does not mention CRMChat, and
 * has no task/integration angle. Writing these is SEO work for the competitor's
 * brand with no realistic CRMChat hook — skip them.
 *
 * Kept (returns false):
 *  - anything mentioning "crmchat" (comparison / migration / brand topic)
 *  - competitor topics with a task signal ("Vtiger Telegram integration guide")
 *  - generic / category topics that name no competitor at all
 */
export function isPureCompetitorTopic(query: string): boolean {
  const q = query.toLowerCase();
  if (q.includes("crmchat")) return false; // comparison / migration / brand — keep
  if (!namesCompetitor(query)) return false; // generic / category — keep
  const hasTaskAngle = TASK_SIGNALS.some((s) => q.includes(s));
  return !hasTaskAngle; // competitor named, no task angle, no CRMChat — skip
}

/**
 * Run keyword research: pull Era (OhMyGEO) AEO queries, filter, and store in
 * the keywords table.
 *
 * Era already normalizes opportunity_score to 0-100 (see era.ts), so we
 * pass-through its score rather than recomputing with calculateOpportunityScore.
 *
 * Gap mode ({ gap: true }): on top of the normal filters, keep ONLY queries
 * where competitors are mentioned in AI answers (competitors > 0) but CRMChat
 * is not (sov is 0 or null). These are the "rivals show up, we don't" topics.
 * Stored with source='era-gap' so the queue can surface them distinctly.
 */
export async function runResearch(opts: { gap?: boolean } = {}): Promise<{
  discovered: number;
  skipped: number;
  mode: "era" | "era-gap";
}> {
  const gap = opts.gap === true;
  const source = gap ? "era-gap" : "era";
  const db = getDb();

  // 1. Fetch Era search queries (AI-provider-generated keywords)
  const queries = await fetchEraQueries();

  if (queries.length === 0) {
    logger.info("No Era queries returned. Is ERA_AI_BRAND_ID set correctly?");
    logSync("research", 0, "empty");
    return { discovered: 0, skipped: 0, mode: source };
  }

  // 2. Get existing article slugs to filter gap keywords
  const existingSlugs = new Set(
    (db.prepare("SELECT slug FROM articles").all() as { slug: string }[]).map(
      (r) => r.slug
    )
  );

  // 3. Get existing keyword queries to avoid duplicates
  const existingQueries = new Set(
    (
      db.prepare("SELECT query FROM keywords").all() as { query: string }[]
    ).map((r) => r.query.toLowerCase())
  );

  // 4. Filter and stage rows for bulk insert
  let discovered = 0;
  let skipped = 0;
  let competitorFiltered = 0;
  let nonGapFiltered = 0;
  const competitorFilteredSamples: string[] = [];

  // Era doesn't expose impressions/clicks/CTR/position — those columns stay NULL.
  // We use opportunity_score (already 0-100 normalized) directly from Era.
  // source is 'era' (normal) or 'era-gap' (competitor-gap mode).
  const insertStmt = db.prepare(
    `INSERT INTO keywords (id, query, source, opportunity_score, status)
     VALUES (?, ?, ?, ?, 'pending')`
  );

  const insertMany = db.transaction(
    (items: Array<{ query: string; score: number }>) => {
      for (const item of items) {
        insertStmt.run(nanoid(), item.query, source, item.score);
      }
    }
  );

  const toInsert: Array<{ query: string; score: number }> = [];

  for (const q of queries) {
    const queryKey = q.query.toLowerCase();

    // Skip if we already have this keyword (existing rows OR earlier in this batch)
    if (existingQueries.has(queryKey)) {
      skipped++;
      continue;
    }

    // Skip if there's already an article with a matching slug
    const slug = queryToSlug(q.query);
    if (existingSlugs.has(slug)) {
      skipped++;
      continue;
    }

    // Skip low-opportunity queries (noise filter)
    if (q.opportunity_score < ERA_SCORE_FILTER) {
      skipped++;
      continue;
    }

    // Gap mode: keep ONLY queries where competitors appear (competitors > 0)
    // and CRMChat does not (sov 0 or null) — the "they're cited, we're not" set.
    if (gap) {
      const competitors = q.competitors ?? 0;
      const ourSov = q.sov ?? 0;
      if (!(competitors > 0 && ourSov === 0)) {
        skipped++;
        nonGapFiltered++;
        continue;
      }
    }

    // Skip pure-competitor topics (competitor named, no CRMChat, no task angle)
    if (isPureCompetitorTopic(q.query)) {
      skipped++;
      competitorFiltered++;
      if (competitorFilteredSamples.length < 20) {
        competitorFilteredSamples.push(q.query);
      }
      continue;
    }

    // Stage the row AND record its keys so a case-insensitive duplicate
    // or slug collision later in the SAME batch is also skipped.
    existingQueries.add(queryKey);
    existingSlugs.add(slug);

    toInsert.push({
      query: q.query,
      score: q.opportunity_score,
    });

    discovered++;
  }

  if (toInsert.length > 0) {
    insertMany(toInsert);
  }

  logSync("research", discovered, "success");
  logger.info(
    {
      mode: source,
      discovered,
      skipped,
      competitorFiltered,
      nonGapFiltered: gap ? nonGapFiltered : undefined,
      competitorFilteredSamples,
      threshold: ERA_SCORE_FILTER,
    },
    "Research complete"
  );

  return { discovered, skipped, mode: source };
}

function logSync(action: string, count: number, status: string) {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_log (id, action, items_count, status) VALUES (?, ?, ?, ?)"
  ).run(nanoid(), action, count, status);
}
