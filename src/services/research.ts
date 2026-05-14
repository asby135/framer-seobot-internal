import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { fetchEraQueries } from "./era.js";
import { queryToSlug } from "../lib/utils.js";
import { logger } from "../lib/logger.js";

const ERA_SCORE_FILTER = 30; // Skip rows with opportunity_score below this threshold

/**
 * Run keyword research: pull Era (OhMyGEO) AEO queries, filter to gap keywords,
 * and store in the keywords table.
 *
 * Era already normalizes opportunity_score to 0-100 (see era.ts), so we
 * pass-through its score rather than recomputing with calculateOpportunityScore.
 */
export async function runResearch(): Promise<{
  discovered: number;
  skipped: number;
}> {
  const db = getDb();

  // 1. Fetch Era search queries (AI-provider-generated keywords)
  const queries = await fetchEraQueries();

  if (queries.length === 0) {
    logger.info("No Era queries returned. Is ERA_AI_BRAND_ID set correctly?");
    logSync("research", 0, "empty");
    return { discovered: 0, skipped: 0 };
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

  // Era doesn't expose impressions/clicks/CTR/position — those columns stay NULL.
  // We use opportunity_score (already 0-100 normalized) directly from Era.
  const insertStmt = db.prepare(
    `INSERT INTO keywords (id, query, source, opportunity_score, status)
     VALUES (?, ?, 'era', ?, 'pending')`
  );

  const insertMany = db.transaction(
    (items: Array<{ query: string; score: number }>) => {
      for (const item of items) {
        insertStmt.run(nanoid(), item.query, item.score);
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
  logger.info({ discovered, skipped, threshold: ERA_SCORE_FILTER }, "Research complete");

  return { discovered, skipped };
}

function logSync(action: string, count: number, status: string) {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_log (id, action, items_count, status) VALUES (?, ?, ?, ?)"
  ).run(nanoid(), action, count, status);
}
