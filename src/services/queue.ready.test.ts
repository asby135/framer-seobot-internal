import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The queue's hand-off to gate 2, with the generator and translator mocked and
 * a real database.
 */

const translate = vi.fn();
const generate = vi.fn();
vi.mock("./translator.js", () => ({ translateArticle: (...a: unknown[]) => translate(...a) }));
vi.mock("./generator.js", () => ({ generateArticle: (...a: unknown[]) => generate(...a) }));

let getDb: typeof import("../db/index.js").getDb;
let queue: typeof import("./queue.js");

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-queue-")), "test.db");
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  queue = await import("./queue.js");
});

beforeEach(() => {
  translate.mockReset();
  generate.mockReset();
  getDb().prepare("DELETE FROM articles").run();
  getDb().prepare("DELETE FROM keywords").run();
  getDb().prepare("INSERT INTO keywords (id, query, status) VALUES ('k1', 'q', 'generated')").run();
  getDb().prepare("INSERT INTO articles (id, keyword_id, title, slug, status) VALUES ('a1', 'k1', 'T', 's', 'review')").run();
  queue.setArticleReadyHandler(null);
});

const readyAt = () =>
  (getDb().prepare("SELECT ready_at FROM articles WHERE id = 'a1'").get() as { ready_at: string | null }).ready_at;

describe("marking an article ready for review", () => {
  it("stamps it when the translation chain hands it to gate 2", async () => {
    translate.mockResolvedValue({ translated: ["ru"] });
    queue.enqueueTranslation({ articleId: "a1", force: false, notifyWhenReady: true });
    await queue.onQueuesIdle();
    expect(readyAt()).not.toBeNull();
  });

  it("stamps it even when translation failed — the article is still shown", async () => {
    translate.mockRejectedValue(new Error("translator down"));
    queue.enqueueTranslation({ articleId: "a1", force: false, notifyWhenReady: true });
    await queue.onQueuesIdle();
    expect(readyAt()).not.toBeNull();
  });

  it("stamps it before the operator is told, so a tap on the message can find it", async () => {
    let seen: string | null | undefined;
    queue.setArticleReadyHandler(() => { seen = readyAt(); });
    translate.mockResolvedValue({});
    queue.enqueueTranslation({ articleId: "a1", force: false, notifyWhenReady: true });
    await queue.onQueuesIdle();
    expect(seen).not.toBeNull();
  });

  it("does not stamp a manual re-translation", async () => {
    translate.mockResolvedValue({});
    queue.enqueueTranslation({ articleId: "a1", force: true });
    await queue.onQueuesIdle();
    expect(readyAt()).toBeNull();
  });
});

describe("a generation that throws", () => {
  it("does not escape the queue as an unhandled rejection", async () => {
    // Node exits on an unhandled rejection: one bad job used to take down the
    // server and every job queued behind it. Vitest fails the run on one too.
    generate.mockRejectedValue(new Error("UNIQUE constraint failed: articles.slug"));
    queue.enqueueGeneration({ keywordId: "k1", query: "q" });
    await queue.onQueuesIdle();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("tells the operator, so the topic does not vanish without a word", async () => {
    const onFailure = vi.fn();
    queue.setGenerationCrashHandler(onFailure);
    generate.mockRejectedValue(new Error("boom"));
    queue.enqueueGeneration({ keywordId: "k1", query: "my topic" });
    await queue.onQueuesIdle();
    expect(onFailure).toHaveBeenCalledWith("my topic", "boom");
    queue.setGenerationCrashHandler(null);
  });

  it("keeps processing the jobs behind it", async () => {
    generate.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ articleId: "a1", status: "review" });
    translate.mockResolvedValue({});
    queue.enqueueGeneration({ keywordId: "k1", query: "first" });
    queue.enqueueGeneration({ keywordId: "k1", query: "second" });
    await queue.onQueuesIdle();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
