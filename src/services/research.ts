import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { fetchGSCQueries } from "./gsc.js";
import { calculateOpportunityScore } from "./scoring.js";
import { queryToSlug } from "../lib/utils.js";
import { logger } from "../lib/logger.js";

/**
 * Run keyword research: pull GSC data, filter to gap keywords,
 * score them, and store in the keywords table.
 */
export async function runResearch(): Promise<{
  discovered: number;
  skipped: number;
}> {
  const db = getDb();

  // 1. Fetch GSC queries (last 90 days)
  const queries = await fetchGSCQueries(90);

  if (queries.length === 0) {
    logger.info("No GSC queries returned. Is the site verified in GSC?");
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

  // 4. Filter and score
  let discovered = 0;
  let skipped = 0;

  const insertStmt = db.prepare(
    `INSERT INTO keywords (id, query, source, impressions, clicks, ctr, position, opportunity_score, status)
     VALUES (?, ?, 'gsc', ?, ?, ?, ?, ?, 'pending')`
  );

  const insertMany = db.transaction(
    (
      items: Array<{
        query: string;
        impressions: number;
        clicks: number;
        ctr: number;
        position: number;
        score: number;
      }>
    ) => {
      for (const item of items) {
        insertStmt.run(
          nanoid(),
          item.query,
          item.impressions,
          item.clicks,
          item.ctr,
          item.position,
          item.score
        );
      }
    }
  );

  const toInsert: Array<{
    query: string;
    impressions: number;
    clicks: number;
    ctr: number;
    position: number;
    score: number;
  }> = [];

  for (const q of queries) {
    // Skip if we already have this keyword
    if (existingQueries.has(q.query.toLowerCase())) {
      skipped++;
      continue;
    }

    // Skip if there's already an article with a matching slug
    const slug = queryToSlug(q.query);
    if (existingSlugs.has(slug)) {
      skipped++;
      continue;
    }

    const score = calculateOpportunityScore({
      impressions: q.impressions,
      ctr: q.ctr,
      position: q.position,
    });

    // Skip very low-score keywords (noise filter)
    if (score < 1) {
      skipped++;
      continue;
    }

    toInsert.push({
      query: q.query,
      impressions: q.impressions,
      clicks: q.clicks,
      ctr: q.ctr,
      position: q.position,
      score,
    });

    discovered++;
  }

  if (toInsert.length > 0) {
    insertMany(toInsert);
  }

  logSync("research", discovered, "success");
  logger.info({ discovered, skipped }, "Research complete");

  return { discovered, skipped };
}

function logSync(action: string, count: number, status: string) {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_log (id, action, items_count, status) VALUES (?, ?, ?, ?)"
  ).run(nanoid(), action, count, status);
}

