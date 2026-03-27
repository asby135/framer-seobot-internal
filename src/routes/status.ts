import { Hono } from "hono";
import { getDb } from "../db/index.js";

const status = new Hono();

status.get("/", (c) => {
  const db = getDb();

  const lastResearch = db
    .prepare(
      "SELECT created_at FROM sync_log WHERE action = 'research' ORDER BY created_at DESC LIMIT 1"
    )
    .get() as { created_at: string } | undefined;

  const lastSync = db
    .prepare(
      "SELECT created_at FROM sync_log WHERE action = 'sync' ORDER BY created_at DESC LIMIT 1"
    )
    .get() as { created_at: string } | undefined;

  const keywordCount = db
    .prepare("SELECT COUNT(*) as count FROM keywords")
    .get() as { count: number };

  const articleCount = db
    .prepare("SELECT COUNT(*) as count FROM articles")
    .get() as { count: number };

  return c.json({
    status: "ok",
    last_research: lastResearch?.created_at ?? null,
    last_sync: lastSync?.created_at ?? null,
    keywords: keywordCount.count,
    articles: articleCount.count,
  });
});

export { status };
