import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Edits and batch publishes from the plugin, with the queue and the Framer side
 * mocked and a real database.
 *
 * An edit to a live article was written to the database and nothing else: the
 * site kept the old text until some unrelated publish carried it out, days
 * later and unannounced; the RU version stayed a translation of the old text;
 * and the content skipped the sanitizer the generator uses.
 */

const enqueueTranslation = vi.fn();
const resyncPublishedArticle = vi.fn(async () => {});
const publishMany = vi.fn(async (ids: string[]) => ({ published: ids, reverted: [] as string[] }));
vi.mock("../services/queue.js", () => ({
  enqueueGeneration: vi.fn(() => true),
  enqueueTranslation: (job: unknown) => enqueueTranslation(job),
  getQueueStatus: () => ({ pending: 0, active: 0, lastResult: null }),
  getTranslationQueueStatus: () => ({ pending: 0, active: 0, lastResult: null }),
}));
vi.mock("../services/bootstrap.js", () => ({
  buildGateHandlers: () => ({ publishMany: (ids: string[]) => publishMany(ids), onPublish: vi.fn() }),
  resyncPublishedArticle: (id: string) => resyncPublishedArticle(id),
}));

let getDb: typeof import("../db/index.js").getDb;
let articles: typeof import("./articles.js").articles;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-edits-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ articles } = await import("./articles.js"));
});

beforeEach(() => {
  enqueueTranslation.mockClear();
  resyncPublishedArticle.mockClear();
  publishMany.mockClear();
  const db = getDb();
  db.prepare("DELETE FROM articles").run();
  db.prepare("DELETE FROM keywords").run();
  db.prepare("INSERT INTO keywords (id, query, status) VALUES ('k1', 'q', 'generated')").run();
});

const add = (id: string, status: string) =>
  getDb().prepare("INSERT INTO articles (id, keyword_id, title, slug, content, status) VALUES (?, 'k1', 'T', ?, '<p>old</p>', ?)").run(id, `slug-${id}`, status);
const post = (path: string, body: unknown) =>
  articles.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const content = (id: string) => (getDb().prepare("SELECT content FROM articles WHERE id = ?").get(id) as { content: string }).content;

describe("POST /:id/update", () => {
  it("sanitizes the content it stores", async () => {
    add("a", "review");
    await post("/a/update", { content: '<p>new</p><script>alert(1)</script><a href="javascript:x">l</a>' });
    expect(content("a")).toBe("<p>new</p><a>l</a>");
  });

  it("re-translates after an edit, so RU is not a translation of the old text", async () => {
    add("a", "review");
    await post("/a/update", { content: "<p>new</p>" });
    expect(enqueueTranslation).toHaveBeenCalledWith({ articleId: "a", force: true });
  });

  it("pushes an edit to a live article to the site", async () => {
    add("a", "published");
    await post("/a/update", { title: "Better Title" });
    expect(resyncPublishedArticle).toHaveBeenCalledWith("a");
  });

  it("leaves the site alone for an article that is not live", async () => {
    add("a", "review");
    await post("/a/update", { title: "Better Title" });
    expect(resyncPublishedArticle).not.toHaveBeenCalled();
  });
});

describe("POST /publish-batch", () => {
  it("publishes the selection in one go", async () => {
    const res = await post("/publish-batch", { article_ids: ["a", "b", "a"] });
    expect(publishMany).toHaveBeenCalledWith(["a", "b"]);
    expect(await res.json()).toEqual({ published: ["a", "b"], reverted: [] });
  });

  it("says when the sync failed", async () => {
    publishMany.mockImplementationOnce(async (ids: string[]) => ({ published: [], reverted: ids }));
    const res = await post("/publish-batch", { article_ids: ["a"] });
    expect(res.status).toBe(502);
  });
});
