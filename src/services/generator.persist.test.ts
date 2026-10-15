import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The generator's database writes, against a real SQLite database.
 *
 * Two of them could do real damage:
 *  - the final UPDATE set `status` unconditionally, so an article published
 *    while its thumbnail was still rendering was flipped back to draft/review —
 *    and the next sync removed it from the site;
 *  - the failure-path INSERT reused the topic's slug with no collision check.
 *    `slug` is UNIQUE, the queue never caught the error, and Node exits on an
 *    unhandled rejection — one failed generation took down the server and
 *    every job queued behind it.
 */

let getDb: typeof import("../db/index.js").getDb;
let finalizeArticle: typeof import("./generator.js").finalizeArticle;
let insertFailedArticle: typeof import("./generator.js").insertFailedArticle;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-gen-persist-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ finalizeArticle, insertFailedArticle } = await import("./generator.js"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM articles").run();
  getDb().prepare("DELETE FROM keywords").run();
  getDb().prepare("INSERT INTO keywords (id, query, status) VALUES ('k1', 'Telegram CRM', 'approved')").run();
});

const addArticle = (id: string, slug: string, status: string) =>
  getDb()
    .prepare("INSERT INTO articles (id, keyword_id, title, slug, content, status) VALUES (?, 'k1', 'T', ?, 'old', ?)")
    .run(id, slug, status);
const row = (id: string) =>
  getDb().prepare("SELECT status, content, flags FROM articles WHERE id = ?").get(id) as {
    status: string; content: string; flags: string;
  };

describe("finalizeArticle", () => {
  it("sets the post-generation status on an article still in draft", () => {
    addArticle("a1", "s1", "draft");
    finalizeArticle(getDb(), "a1", "<p>final</p>", "review", { thumbnail_missing: true });
    expect(row("a1")).toMatchObject({ status: "review", content: "<p>final</p>" });
  });

  it("does not pull an article back out of 'published'", () => {
    addArticle("a1", "s1", "published");
    finalizeArticle(getDb(), "a1", "<p>final</p>", "review", {});
    expect(row("a1").status).toBe("published");
    // The finished content still lands — it is strictly better than the
    // pre-asset copy that was published.
    expect(row("a1").content).toBe("<p>final</p>");
  });
});

describe("insertFailedArticle", () => {
  it("records the failure and marks the topic used", () => {
    const id = insertFailedArticle(getDb(), "k1", "Telegram CRM", "boom");
    expect(row(id).status).toBe("generation_failed");
    const kw = getDb().prepare("SELECT status FROM keywords WHERE id = 'k1'").get() as { status: string };
    expect(kw.status).toBe("generated");
  });

  it("does not throw when the topic's slug is already taken", () => {
    addArticle("live", "telegram-crm", "published");
    expect(() => insertFailedArticle(getDb(), "k1", "Telegram CRM", "boom")).not.toThrow();
  });

  it("does not throw for a topic that fails twice", () => {
    insertFailedArticle(getDb(), "k1", "Telegram CRM", "first");
    expect(() => insertFailedArticle(getDb(), "k1", "Telegram CRM", "second")).not.toThrow();
  });
});
