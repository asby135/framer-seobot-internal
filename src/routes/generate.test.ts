import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The plugin's Generate buttons, against a real database with the queue
 * mocked.
 *
 * A topic approved in Telegram sits 'approved' with no article for the
 * minutes its generation waits and runs. The Generate tab listed it and these
 * routes accepted it, so one click produced a second article for the same
 * topic — double the spend, under a headline nobody approved.
 */

const enqueueGeneration = vi.fn((_job: unknown) => true);
vi.mock("../services/queue.js", () => ({
  enqueueGeneration: (job: unknown) => enqueueGeneration(job),
  getQueueStatus: () => ({ pending: 0, active: 0, lastResult: null }),
}));

let getDb: typeof import("../db/index.js").getDb;
let generate: typeof import("./generate.js").generate;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-generate-")), "test.db");
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ generate } = await import("./generate.js"));
});

beforeEach(() => {
  enqueueGeneration.mockClear();
  enqueueGeneration.mockImplementation(() => true);
  getDb().prepare("DELETE FROM keywords").run();
});

const kw = (id: string, opts: { job?: boolean; proposed?: string } = {}) =>
  getDb()
    .prepare("INSERT INTO keywords (id, query, status, proposed_title, generation_job) VALUES (?, ?, 'approved', ?, ?)")
    .run(id, `topic ${id}`, opts.proposed ?? null, opts.job ? '{"query":"x"}' : null);
const post = (path: string, body: unknown) =>
  generate.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/generate", () => {
  it("will not generate a topic that is already queued", async () => {
    kw("k1", { job: true });
    const res = await post("/", { keyword_id: "k1" });
    expect(res.status).toBe(404);
    expect(enqueueGeneration).not.toHaveBeenCalled();
  });

  it("writes under the headline proposed in the digest", async () => {
    kw("k1", { proposed: "The Digest Headline" });
    await post("/", { keyword_id: "k1" });
    expect(enqueueGeneration).toHaveBeenCalledWith({ keywordId: "k1", query: "topic k1", titleOverride: "The Digest Headline" });
  });
});

describe("POST /api/generate/batch", () => {
  it("skips queued topics and enqueues the rest", async () => {
    kw("k1", { job: true });
    kw("k2");
    const res = await post("/batch", { keyword_ids: ["k1", "k2"] });
    const body = (await res.json()) as { enqueued: Array<{ keyword_id: string }> };
    expect(body.enqueued.map((e) => e.keyword_id)).toEqual(["k2"]);
    expect(enqueueGeneration).toHaveBeenCalledOnce();
  });

  it("reports a topic the queue refused as already queued", async () => {
    // A race the SELECT cannot see: queued between the read and the enqueue.
    kw("k1");
    enqueueGeneration.mockImplementation(() => false);
    const res = await post("/batch", { keyword_ids: ["k1"] });
    const body = (await res.json()) as { enqueued: unknown[]; skipped: Array<{ reason: string }> };
    expect(body.enqueued).toEqual([]);
    expect(body.skipped[0].reason).toBe("already-queued");
  });
});
