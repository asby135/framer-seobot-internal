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
    getDb().prepare("INSERT INTO keywords (id, query, status) VALUES ('k2', 'q2', 'approved')").run();
    generate.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ articleId: "a1", status: "review" });
    translate.mockResolvedValue({});
    queue.enqueueGeneration({ keywordId: "k1", query: "first" });
    queue.enqueueGeneration({ keywordId: "k2", query: "second" });
    await queue.onQueuesIdle();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe("one generation per topic, recorded so a restart can resume it", () => {
  const job = () =>
    (getDb().prepare("SELECT generation_job FROM keywords WHERE id = 'k1'").get() as { generation_job: string | null })
      .generation_job;

  it("refuses to queue a topic that is already queued", async () => {
    // Approved in Telegram, then generated again from the plugin's Generate
    // tab while still waiting its turn: two articles, twice the spend.
    let release!: () => void;
    generate.mockImplementation(() => new Promise((r) => { release = () => r({ articleId: "a1", status: "generation_failed" }); }));
    expect(queue.enqueueGeneration({ keywordId: "k1", query: "q" })).toBe(true);
    expect(queue.enqueueGeneration({ keywordId: "k1", query: "q" })).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await queue.onQueuesIdle();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("records the job the moment it is queued", async () => {
    let release!: () => void;
    generate.mockImplementation(() => new Promise((r) => { release = () => r({ articleId: "a1", status: "generation_failed" }); }));
    queue.enqueueGeneration({ keywordId: "k1", query: "q", titleOverride: "The Headline" });
    expect(JSON.parse(job()!)).toEqual({ query: "q", titleOverride: "The Headline" });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await queue.onQueuesIdle();
  });

  it("clears the record when the job ends, so the topic can be queued again", async () => {
    generate.mockResolvedValue({ articleId: "a1", status: "generation_failed" });
    queue.enqueueGeneration({ keywordId: "k1", query: "q" });
    await queue.onQueuesIdle();
    expect(job()).toBeNull();
    expect(queue.enqueueGeneration({ keywordId: "k1", query: "q" })).toBe(true);
    await queue.onQueuesIdle();
  });

  it("clears the record when the job crashes too", async () => {
    generate.mockRejectedValue(new Error("boom"));
    queue.enqueueGeneration({ keywordId: "k1", query: "q" });
    await queue.onQueuesIdle();
    expect(job()).toBeNull();
  });
});

describe("a failed generation", () => {
  it("releases the topic before the operator is told, so a restart mid-message does not rerun it", async () => {
    let jobDuringNotify: unknown = "unset";
    queue.setArticleReadyHandler(() => {
      jobDuringNotify = (getDb().prepare("SELECT generation_job FROM keywords WHERE id = 'k1'").get() as { generation_job: unknown }).generation_job;
    });
    generate.mockResolvedValue({ articleId: "a1", status: "generation_failed" });
    queue.enqueueGeneration({ keywordId: "k1", query: "q" });
    await queue.onQueuesIdle();
    expect(jobDuringNotify).toBeNull();
  });
});

describe("after a translation", () => {
  it("tells whoever is listening, so a live article's new RU reaches the site", async () => {
    const onTranslated = vi.fn();
    queue.setTranslationCompleteHandler(onTranslated);
    translate.mockResolvedValue({ translated: ["ru"], skipped: [], failed: [] });
    queue.enqueueTranslation({ articleId: "a1", force: true });
    await queue.onQueuesIdle();
    expect(onTranslated).toHaveBeenCalledWith("a1");
    queue.setTranslationCompleteHandler(null);
  });

  it("stays quiet when the translation failed", async () => {
    const onTranslated = vi.fn();
    queue.setTranslationCompleteHandler(onTranslated);
    translate.mockRejectedValue(new Error("down"));
    queue.enqueueTranslation({ articleId: "a1", force: true });
    await queue.onQueuesIdle();
    expect(onTranslated).not.toHaveBeenCalled();
    queue.setTranslationCompleteHandler(null);
  });
});

describe("translation hook and queue hygiene", () => {
  it("does not fire for a translation that changed nothing", async () => {
    // Fired after every translation, so a bulk re-translate of already-
    // translated live articles ran one Framer sync and a deploy each.
    const onTranslated = vi.fn();
    queue.setTranslationCompleteHandler(onTranslated);
    translate.mockResolvedValue({ translated: [], skipped: ["ru"], failed: [] });
    queue.enqueueTranslation({ articleId: "a1", force: false });
    await queue.onQueuesIdle();
    expect(onTranslated).not.toHaveBeenCalled();
    queue.setTranslationCompleteHandler(null);
  });

  it("does not hold the translation queue while the hook works", async () => {
    // The hook syncs to Framer (~70s warm-up); awaiting it stalled every
    // translation queued behind, including new articles bound for gate 2.
    let release!: () => void;
    queue.setTranslationCompleteHandler(() => new Promise<void>((r) => { release = r; }));
    translate.mockResolvedValue({ translated: ["ru"], skipped: [], failed: [] });
    queue.enqueueTranslation({ articleId: "a1", force: true });
    queue.enqueueTranslation({ articleId: "a2", force: true });
    await queue.onQueuesIdle(); // would hang if the hook were awaited
    expect(translate).toHaveBeenCalledTimes(2);
    release();
    queue.setTranslationCompleteHandler(null);
  });

  it("queues one forced re-translation per article, however many saves", async () => {
    let release!: () => void;
    translate.mockImplementation(() => new Promise((r) => { release = () => r({ translated: ["ru"] }); }));
    queue.enqueueTranslation({ articleId: "busy", force: true }); // occupies the queue
    queue.enqueueTranslation({ articleId: "a1", force: true });
    queue.enqueueTranslation({ articleId: "a1", force: true });
    queue.enqueueTranslation({ articleId: "a1", force: true });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await queue.onQueuesIdle();
    expect(translate.mock.calls.filter((c) => c[0] === "a1")).toHaveLength(1);
  });
});
