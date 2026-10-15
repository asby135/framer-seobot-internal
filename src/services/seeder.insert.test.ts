import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * insertSeededTopics against a real database.
 *
 * Exact-text and exact-slug matches were always rejected. What got through was
 * a REWORDED repeat of an older article: the seeder prompt only lists the most
 * recent ~90 topics and titles, so anything older than that was invisible to
 * every check.
 */

let getDb: typeof import("../db/index.js").getDb;
let insertSeededTopics: typeof import("./seeder.js").insertSeededTopics;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-seeder-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ insertSeededTopics } = await import("./seeder.js"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM articles").run();
  getDb().prepare("DELETE FROM keywords").run();
});

const addArticle = (title: string, slug: string, status = "published") =>
  getDb()
    .prepare("INSERT INTO articles (id, title, slug, status) VALUES (?, ?, ?, ?)")
    .run(slug, title, slug, status);

const pendingQueries = () =>
  (getDb().prepare("SELECT query FROM keywords WHERE status = 'pending'").all() as { query: string }[]).map(
    (r) => r.query
  );

describe("insertSeededTopics — near-duplicate guard", () => {
  it("skips a reworded repeat of a published article, however old", () => {
    addArticle("How to Export Telegram Group Members to CSV", "export-telegram-group-members-csv");
    const r = insertSeededTopics(["How to Export Members From a Telegram Group to a CSV File"]);
    expect(r.seeded).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.nearDuplicates).toEqual([
      {
        query: "How to Export Members From a Telegram Group to a CSV File",
        matched: "How to Export Telegram Group Members to CSV",
      },
    ]);
  });

  it("skips a reworded repeat of a topic already in the queue", () => {
    insertSeededTopics(["Why Telegram Accounts Get Banned for Bulk Messaging"]);
    const r = insertSeededTopics(["Why Telegram Accounts Get Banned for Bulk Messages"]);
    expect(r.seeded).toHaveLength(0);
    expect(pendingQueries()).toHaveLength(1);
  });

  it("skips a reworded repeat of a topic the operator rejected", () => {
    insertSeededTopics(["Why Telegram Accounts Get Banned for Bulk Messaging"]);
    getDb().prepare("UPDATE keywords SET status = 'rejected'").run();
    const r = insertSeededTopics(["Why Telegram Accounts Get Banned for Bulk Messages"]);
    expect(r.seeded).toHaveLength(0);
    expect(pendingQueries()).toHaveLength(0);
  });

  it("skips near-duplicates inside one batch, keeping the first", () => {
    const r = insertSeededTopics([
      "How to Export Telegram Group Members to CSV",
      "How to Export Members From a Telegram Group to a CSV File",
    ]);
    expect(r.seeded.map((s) => s.query)).toEqual(["How to Export Telegram Group Members to CSV"]);
  });

  it("does not hold a failed generation against the topic", () => {
    // generation_failed rows carry the topic as their title but no article was
    // written, so the ground is still open.
    addArticle("How to Export Telegram Group Members to CSV", "failed-1", "generation_failed");
    const r = insertSeededTopics(["How to Export Members From a Telegram Group to a CSV File"]);
    expect(r.seeded).toHaveLength(1);
  });

  it("still inserts genuinely new topics", () => {
    addArticle("How to Export Telegram Group Members to CSV", "export-telegram-group-members-csv");
    const r = insertSeededTopics(["How to Rotate Chatter Shifts to Cover Fan Chats Around the Clock"]);
    expect(r.seeded).toHaveLength(1);
    expect(r.nearDuplicates).toEqual([]);
  });

  it("revives an exactly-matching rejected topic on a deliberate import", () => {
    // Re-importing the exact text of something rejected, by hand, means the
    // operator wants it back.
    insertSeededTopics(["Why Telegram Accounts Get Banned for Bulk Messaging"]);
    getDb().prepare("UPDATE keywords SET status = 'rejected'").run();
    const r = insertSeededTopics(["Why Telegram Accounts Get Banned for Bulk Messaging"], undefined, {
      reviveRejected: true,
    });
    expect(r.revived).toBe(1);
    expect(pendingQueries()).toHaveLength(1);
  });
});

describe("insertSeededTopics — a rejection sticks", () => {
  const TOPIC = "Why Telegram Accounts Get Banned for Bulk Messaging";
  const reject = () =>
    getDb().prepare("UPDATE keywords SET status = 'rejected', proposed_title = query").run();
  const row = () =>
    getDb().prepare("SELECT status, niche, proposed_title FROM keywords").get() as {
      status: string; niche: string | null; proposed_title: string | null;
    };

  it("does not bring a rejected topic back from automatic seeding", () => {
    // Telegram tells the operator a rejected topic "will not be proposed
    // again". The nightly seeder shared the import's revive path, so Claude
    // repeating the exact text months later put it straight back.
    insertSeededTopics([TOPIC], "Web3 / crypto");
    reject();
    const r = insertSeededTopics([TOPIC], "Web3 / crypto");
    expect(r.revived).toBe(0);
    expect(r.skipped).toBe(1);
    expect(row().status).toBe("rejected");
  });

  it("offers a deliberately revived topic afresh", () => {
    // Its old proposed_title marked it as already offered, so it never counted
    // toward the pool and only ever filled a short night.
    insertSeededTopics([TOPIC], "Web3 / crypto");
    reject();
    insertSeededTopics([TOPIC], undefined, { reviveRejected: true });
    expect(row().proposed_title).toBeNull();
  });

  it("keeps the topic's niche when the import names none", () => {
    // A blank niche on revive slipped a probationary topic past probation.
    insertSeededTopics([TOPIC], "Online currency exchanges");
    reject();
    insertSeededTopics([TOPIC], undefined, { reviveRejected: true });
    expect(row().niche).toBe("Online currency exchanges");
  });
});
