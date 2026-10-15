import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The plugin's Delete and Regenerate on a LIVE article.
 *
 * Telegram refuses both for published articles; the HTTP routes did not.
 * Delete was one click with no confirmation, and the next sync removed the
 * article from the site. Regenerate deleted the row and let the model invent a
 * new slug, so the indexed URL — and every internal link to it — went 404.
 */

let getDb: typeof import("../db/index.js").getDb;
let articles: typeof import("./articles.js").articles;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-guards-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ articles } = await import("./articles.js"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM articles").run();
  db.prepare("DELETE FROM keywords").run();
  db.prepare("INSERT INTO keywords (id, query, status) VALUES ('k1', 'q', 'generated')").run();
});

const add = (id: string, status: string) =>
  getDb().prepare("INSERT INTO articles (id, keyword_id, title, slug, status) VALUES (?, 'k1', 'T', ?, ?)").run(id, `slug-${id}`, status);
const exists = (id: string) => Boolean(getDb().prepare("SELECT 1 FROM articles WHERE id = ?").get(id));
const post = (path: string, body?: unknown) =>
  articles.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /:id/delete", () => {
  it("refuses a published article unless the caller confirms it is taking it off the site", async () => {
    add("live", "published");
    const res = await post("/live/delete");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/live/i);
    expect(exists("live")).toBe(true);
  });

  it("deletes a published article when that is confirmed", async () => {
    add("live", "published");
    expect((await post("/live/delete", { removeLive: true })).status).toBe(200);
    expect(exists("live")).toBe(false);
  });

  it("still deletes a draft without ceremony", async () => {
    add("d", "review");
    expect((await post("/d/delete")).status).toBe(200);
    expect(exists("d")).toBe(false);
  });
});

describe("POST /:id/regenerate", () => {
  it("refuses a published article and leaves it untouched", async () => {
    add("live", "published");
    const res = await post("/live/regenerate", {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/url/i);
    expect(exists("live")).toBe(true);
  });
});
