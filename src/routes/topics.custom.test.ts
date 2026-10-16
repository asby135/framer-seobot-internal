import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Custom topics from the plugin. They went straight in as 'approved' with no
 * duplicate check of any kind — and vanished from the screen they were added
 * on, so adding one twice (or a rewording of a published article) was easy.
 */

let getDb: typeof import("../db/index.js").getDb;
let topics: typeof import("./topics.js").topics;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-custom-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ topics } = await import("./topics.js"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM articles").run();
  getDb().prepare("DELETE FROM keywords").run();
  getDb().prepare("INSERT INTO keywords (id, query, status) VALUES ('k0', 'x', 'generated')").run();
  getDb()
    .prepare("INSERT INTO articles (id, keyword_id, title, slug, status) VALUES ('a0', 'k0', 'How to Export Telegram Group Members to CSV', 'export', 'published')")
    .run();
});

const add = (body: unknown) =>
  topics.request("/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("POST /custom", () => {
  it("adds a new topic as approved", async () => {
    const res = await add({ query: "How to Rotate Chatter Shifts Around the Clock" });
    expect(res.status).toBe(201);
  });

  it("refuses an exact repeat of an existing article", async () => {
    const res = await add({ query: "how to export telegram group members to csv" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { matched: string }).matched).toBe("How to Export Telegram Group Members to CSV");
  });

  it("refuses a rewording, naming what it collides with", async () => {
    const res = await add({ query: "How to Export Members From a Telegram Group to a CSV File" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { matched: string }).matched).toBe("How to Export Telegram Group Members to CSV");
  });

  it("adds it anyway when the operator insists", async () => {
    const res = await add({ query: "How to Export Members From a Telegram Group to a CSV File", force: true });
    expect(res.status).toBe(201);
  });
});

describe("POST /custom against an existing topic", () => {
  const kw = (id: string, query: string, status: string) =>
    getDb().prepare("INSERT INTO keywords (id, query, status, source) VALUES (?, ?, ?, 'seeded')").run(id, query, status);
  const status = (id: string) => (getDb().prepare("SELECT status FROM keywords WHERE id = ?").get(id) as { status: string }).status;
  const count = (q: string) => (getDb().prepare("SELECT COUNT(*) AS n FROM keywords WHERE lower(query) = lower(?)").get(q) as { n: number }).n;

  it("says which state the existing topic is in", async () => {
    kw("p1", "How to Rotate Chatter Shifts", "pending");
    const body = (await (await add({ query: "how to rotate chatter shifts" })).json()) as { error: string };
    expect(body.error).toMatch(/pending/i);
  });

  it("'Add anyway' on a pending topic approves that row instead of adding a second", async () => {
    kw("p1", "How to Rotate Chatter Shifts", "pending");
    const res = await add({ query: "how to rotate chatter shifts", force: true });
    expect(res.status).toBe(201);
    expect(status("p1")).toBe("approved");
    expect(count("How to Rotate Chatter Shifts")).toBe(1);
  });

  it("'Add anyway' on a rejected topic brings that row back", async () => {
    kw("r1", "How to Rotate Chatter Shifts", "rejected");
    await add({ query: "How to Rotate Chatter Shifts", force: true });
    expect(status("r1")).toBe("approved");
    expect(count("How to Rotate Chatter Shifts")).toBe(1);
  });

  it("refuses even with force when the topic is already approved or written", async () => {
    kw("a1", "How to Rotate Chatter Shifts", "approved");
    expect((await add({ query: "How to Rotate Chatter Shifts", force: true })).status).toBe(409);
  });
});
