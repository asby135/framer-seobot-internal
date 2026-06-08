import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Pin a fresh DB path before importing modules that load env.
const testDir = mkdtempSync(join(tmpdir(), "research-source-branch-"));
process.env.DATABASE_PATH = join(testDir, "test.db");
process.env.ERA_AI_API_KEY = "omg_test_key";
process.env.ERA_AI_BRAND_ID = "test-brand-id";

const fetchEraQueriesMock = vi.fn();

vi.mock("./era.js", () => ({
  fetchEraQueries: () => fetchEraQueriesMock(),
}));

const { initDb, getDb, closeDb } = await import("../db/index.js");
const { runResearch } = await import("./research.js");

beforeEach(() => {
  fetchEraQueriesMock.mockReset();
  initDb();
});

afterEach(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

function makeEraQuery(overrides: Partial<{
  query: string;
  count: number;
  sov: number | null;
  category: string | null;
  opportunity_score: number;
}> = {}) {
  return {
    query: "Best Telegram CRM",
    count: 10,
    sov: 10,
    category: "Telegram CRM",
    opportunity_score: 75,
    raw: {} as never,
    ...overrides,
  };
}

describe("runResearch (Era source)", () => {
  it("inserts Era queries with source='era' and passes through opportunity_score", async () => {
    fetchEraQueriesMock.mockResolvedValue([
      makeEraQuery({ query: "CRMChat pricing", opportunity_score: 95 }),
      makeEraQuery({ query: "Best Telegram CRM", opportunity_score: 60 }),
    ]);

    const result = await runResearch();
    expect(result.discovered).toBe(2);
    expect(result.skipped).toBe(0);

    const rows = getDb()
      .prepare("SELECT query, source, opportunity_score FROM keywords ORDER BY opportunity_score DESC")
      .all() as Array<{ query: string; source: string; opportunity_score: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ query: "CRMChat pricing", source: "era", opportunity_score: 95 });
    expect(rows[1]).toEqual({ query: "Best Telegram CRM", source: "era", opportunity_score: 60 });
  });

  it("filters out queries with opportunity_score below the threshold (currently 5)", async () => {
    fetchEraQueriesMock.mockResolvedValue([
      makeEraQuery({ query: "high score", opportunity_score: 80 }),
      makeEraQuery({ query: "right at threshold", opportunity_score: 5 }),
      makeEraQuery({ query: "below threshold", opportunity_score: 4.99 }),
      makeEraQuery({ query: "way below", opportunity_score: 1 }),
    ]);

    const result = await runResearch();
    expect(result.discovered).toBe(2); // 80 and 5 pass; 4.99 and 1 fail
    expect(result.skipped).toBe(2);

    const queries = getDb()
      .prepare("SELECT query FROM keywords ORDER BY opportunity_score DESC")
      .all() as Array<{ query: string }>;
    expect(queries.map((r) => r.query)).toEqual(["high score", "right at threshold"]);
  });

  it("skips queries that are case-insensitive duplicates of existing keywords", async () => {
    // Seed an existing keyword
    getDb()
      .prepare(
        `INSERT INTO keywords (id, query, source, opportunity_score, status)
         VALUES ('seed', 'CRMChat Pricing', 'era', 50, 'pending')`
      )
      .run();

    fetchEraQueriesMock.mockResolvedValue([
      makeEraQuery({ query: "crmchat pricing", opportunity_score: 95 }), // dup (case-insensitive)
      makeEraQuery({ query: "New Query", opportunity_score: 70 }), // new
    ]);

    const result = await runResearch();
    expect(result.discovered).toBe(1);
    expect(result.skipped).toBe(1);

    const count = getDb().prepare("SELECT COUNT(*) AS n FROM keywords").get() as { n: number };
    expect(count.n).toBe(2); // seed + 1 new
  });

  it("skips queries whose slug collides with an existing article", async () => {
    // Seed an existing article whose slug matches the slug derived from the query
    getDb()
      .prepare(
        `INSERT INTO articles (id, title, slug, status)
         VALUES ('seed-article', 'Best Telegram CRM 2026', 'best-telegram-crm-2026', 'published')`
      )
      .run();

    fetchEraQueriesMock.mockResolvedValue([
      makeEraQuery({ query: "Best Telegram CRM 2026", opportunity_score: 80 }),
    ]);

    const result = await runResearch();
    expect(result.discovered).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("returns 0/0 when Era returns no queries", async () => {
    fetchEraQueriesMock.mockResolvedValue([]);
    const result = await runResearch();
    expect(result).toEqual({ discovered: 0, skipped: 0 });
  });

  it("filters pure-competitor topics but keeps comparison, task, and generic ones", async () => {
    fetchEraQueriesMock.mockResolvedValue([
      // Bucket 1 — pure competitor, no CRMChat, no task angle → SKIP
      makeEraQuery({ query: "nReach pricing details", opportunity_score: 80 }),
      makeEraQuery({ query: "Entergram customer support reviews", opportunity_score: 75 }),
      makeEraQuery({ query: "HubSpot vs Zoho", opportunity_score: 70 }),
      // Bucket 2 — mentions CRMChat → KEEP
      makeEraQuery({ query: "CRMChat vs nReach user reviews", opportunity_score: 85 }),
      makeEraQuery({ query: "How to migrate data from Enreach to CRMChat", opportunity_score: 84 }),
      // Bucket 3 — competitor + task/integration angle → KEEP
      makeEraQuery({ query: "Vtiger CRM Telegram integration setup guide", opportunity_score: 83 }),
      // Generic — names no competitor → KEEP
      makeEraQuery({ query: "Best free Telegram CRM alternatives", opportunity_score: 82 }),
    ]);

    const result = await runResearch();
    expect(result.discovered).toBe(4); // 2 bucket-2 + 1 bucket-3 + 1 generic
    expect(result.skipped).toBe(3); // 3 bucket-1

    const kept = (
      getDb().prepare("SELECT query FROM keywords ORDER BY opportunity_score DESC").all() as Array<{ query: string }>
    ).map((r) => r.query);
    expect(kept).toEqual([
      "CRMChat vs nReach user reviews",
      "How to migrate data from Enreach to CRMChat",
      "Vtiger CRM Telegram integration setup guide",
      "Best free Telegram CRM alternatives",
    ]);
  });
});
