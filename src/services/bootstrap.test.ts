import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * bootstrap.ts is the only place the unit-tested pieces meet a real database,
 * so it is the only place a SQL-level bug can hide. It hid one: the delete
 * handlers removed the parent row before its children, which throws under
 * `foreign_keys = ON` — 100% of the time, since every generated article has a
 * thumbnail asset and a translation row.
 *
 * These tests use a real SQLite database rather than mocks, because mocking
 * the database is precisely what let the bug through.
 */

let buildGateHandlers: typeof import("./bootstrap.js").buildGateHandlers;
let getDb: typeof import("../db/index.js").getDb;
let publishIsOverdue: typeof import("./bootstrap.js").publishIsOverdue;
let articlesAwaitingAnnouncement: typeof import("./bootstrap.js").articlesAwaitingAnnouncement;
let markAnnounced: typeof import("./bootstrap.js").markAnnounced;
let articleUrl: typeof import("./bootstrap.js").articleUrl;
let articlesReadyForReview: typeof import("./bootstrap.js").articlesReadyForReview;
let recoverOrphanedReviews: typeof import("./bootstrap.js").recoverOrphanedReviews;
let recoverInterruptedGenerations: typeof import("./bootstrap.js").recoverInterruptedGenerations;
let articlesSyncedSince: typeof import("./bootstrap.js").articlesSyncedSince;
let unpublishArticleRow: typeof import("./bootstrap.js").unpublishArticleRow;
let describeFlags: typeof import("./bootstrap.js").describeFlags;
let recordDigest: typeof import("./bootstrap.js").recordDigest;
let pendingInDigest: typeof import("./bootstrap.js").pendingInDigest;
let forgetDigest: typeof import("./bootstrap.js").forgetDigest;
let digestItems: typeof import("./bootstrap.js").digestItems;
let failureNotice: typeof import("./bootstrap.js").failureNotice;

beforeAll(async () => {
  // env.ts snapshots process.env at import time, so this must be set before
  // any module that reads it is loaded — hence the dynamic imports below.
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-bootstrap-")), "test.db");
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ buildGateHandlers, publishIsOverdue, articlesAwaitingAnnouncement, markAnnounced, articleUrl, articlesReadyForReview, recoverOrphanedReviews, recoverInterruptedGenerations, articlesSyncedSince, unpublishArticleRow, describeFlags, recordDigest, pendingInDigest, forgetDigest, digestItems, failureNotice } =
    await import("./bootstrap.js"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM assets").run();
  db.prepare("DELETE FROM article_translations").run();
  db.prepare("DELETE FROM articles").run();
  db.prepare("DELETE FROM keywords").run();
  db.prepare("DELETE FROM framer_sync_state").run();
});

function seedArticle(id = "a1", keywordId = "k1") {
  const db = getDb();
  db.prepare("INSERT INTO keywords (id, query, status) VALUES (?, ?, 'generated')").run(keywordId, "a topic");
  db.prepare("INSERT INTO articles (id, keyword_id, title, slug, status) VALUES (?, ?, 'T', ?, 'review')")
    .run(id, keywordId, `slug-${id}`);
  // Every real article has both of these — they are what made the bug certain.
  db.prepare("INSERT INTO assets (id, article_id, type, url) VALUES (?, ?, 'thumbnail', 'u')").run(`as-${id}`, id);
  db.prepare("INSERT INTO article_translations (id, article_id, locale, title) VALUES (?, ?, 'ru', 'RU')").run(`t-${id}`, id);
}

describe("deleteArticle", () => {
  it("deletes an article that has assets and translations", async () => {
    seedArticle();
    const handlers = buildGateHandlers();

    await expect(handlers.onDelete("a1", 1)).resolves.toBeUndefined();

    const row = getDb().prepare("SELECT id FROM articles WHERE id = 'a1'").get();
    expect(row).toBeUndefined();
  });

  it("removes the children too, leaving no orphans", async () => {
    seedArticle();
    await buildGateHandlers().onDelete("a1", 1);

    const db = getDb();
    expect(db.prepare("SELECT COUNT(*) c FROM assets WHERE article_id = 'a1'").get()).toEqual({ c: 0 });
    expect(
      db.prepare("SELECT COUNT(*) c FROM article_translations WHERE article_id = 'a1'").get()
    ).toEqual({ c: 0 });
  });

  it("is a no-op for an unknown article", async () => {
    await expect(buildGateHandlers().onDelete("nope", 1)).resolves.toBeUndefined();
  });
});

describe("regenerateArticle", () => {
  it("deletes the article without a foreign-key error", async () => {
    seedArticle();
    await expect(buildGateHandlers().onRegenerate("a1", 1)).resolves.toBeUndefined();
    expect(getDb().prepare("SELECT id FROM articles WHERE id = 'a1'").get()).toBeUndefined();
  });

  it("resets the keyword to approved so the pipeline can regenerate it", async () => {
    seedArticle();
    await buildGateHandlers().onRegenerate("a1", 1);

    const kw = getDb().prepare("SELECT status FROM keywords WHERE id = 'k1'").get() as { status: string };
    expect(kw.status).toBe("approved");
  });
});

describe("publishIsOverdue", () => {
  const WINDOW = 5 * 60 * 1000;
  const now = new Date("2026-08-21T16:40:00Z").getTime();

  it("is false while the publish is still inside its debounce window", () => {
    expect(publishIsOverdue("2026-08-21T16:38:00Z", now, WINDOW)).toBe(false);
  });

  it("is true once it has waited longer than the window", () => {
    // Re-arming restarts the countdown, so a service redeploying every couple
    // of minutes would never deploy — each boot pushes the deadline out again
    // while changes pile up in Framer as pending.
    expect(publishIsOverdue("2026-08-21T16:30:00Z", now, WINDOW)).toBe(true);
  });

  it("is true exactly at the boundary", () => {
    expect(publishIsOverdue("2026-08-21T16:35:00Z", now, WINDOW)).toBe(true);
  });

  it("re-arms rather than deploying on a corrupt timestamp", () => {
    expect(publishIsOverdue("not-a-date", now, WINDOW)).toBe(false);
  });
});

describe("articlesAwaitingAnnouncement", () => {
  it("returns published articles that have not been announced", () => {
    getDb()
      .prepare(
        `INSERT INTO articles (id, keyword_id, title, slug, content, status, published_at)
         VALUES ('a1', NULL, 'Fresh', 'fresh', '<p>x</p>', 'published', '2026-08-24 16:29:14')`
      )
      .run();
    expect(articlesAwaitingAnnouncement().map((a) => a.slug)).toContain("fresh");
  });

  it("does not return an article once it has been announced", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, content, status, published_at)
       VALUES ('a2', NULL, 'Told', 'told', '<p>x</p>', 'published', '2026-08-24 16:29:14')`
    ).run();
    markAnnounced(["a2"]);
    expect(articlesAwaitingAnnouncement().map((a) => a.slug)).not.toContain("told");
  });

  it("re-offers an article that a previous deploy failed to announce", () => {
    // The timestamp version could not do this: a deploy firing between two
    // publishes moved the window past an article, and it was never mentioned
    // again. The flag makes a miss self-healing.
    const db = getDb();
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, content, status, published_at)
       VALUES ('a3', NULL, 'Missed', 'missed', '<p>x</p>', 'published', '2026-08-20 09:00:00')`
    ).run();
    expect(articlesAwaitingAnnouncement().map((a) => a.slug)).toContain("missed");
    expect(articlesAwaitingAnnouncement().map((a) => a.slug)).toContain("missed");
  });

  it("ignores articles that are not published", () => {
    getDb()
      .prepare(
        `INSERT INTO articles (id, keyword_id, title, slug, content, status)
         VALUES ('a4', NULL, 'Draft', 'draft-one', '<p>x</p>', 'review')`
      )
      .run();
    expect(articlesAwaitingAnnouncement().map((a) => a.slug)).not.toContain("draft-one");
  });
});

describe("articleUrl", () => {
  const SITE = "https://crmchat.ai/blog";

  it("falls back to the bare slug when SITE_URL is unset", () => {
    expect(articleUrl("some-slug", "")).toBe("/some-slug");
  });

  it("joins the base and the slug with exactly one separator", () => {
    expect(articleUrl("telegram-vs-signal", SITE)).toBe(
      "https://crmchat.ai/blog/telegram-vs-signal"
    );
  });

  it("does NOT double the path prefix", () => {
    // SITE_URL carries /blog and the slug never does — they are built in
    // different places (this helper vs the generator's hardcoded
    // <a href="/blog/slug"> body links) and never concatenated with each other.
    expect(articleUrl("telegram-vs-signal", SITE)).not.toContain("/blog/blog");
  });

  it("tolerates a trailing slash on the base", () => {
    expect(articleUrl("x", "https://crmchat.ai/blog/")).toBe("https://crmchat.ai/blog/x");
    expect(articleUrl("x", "https://crmchat.ai/blog///")).toBe("https://crmchat.ai/blog/x");
  });

  it("keeps a slug that legitimately starts with the word blog", () => {
    // A title beginning "Blog…" yields such a slug. /blog/blog-post-ideas is
    // the correct URL, not a duplicated prefix.
    expect(articleUrl("blog-post-ideas", SITE)).toBe("https://crmchat.ai/blog/blog-post-ideas");
  });
});

describe("articlesReadyForReview — what Publish all may publish", () => {
  // Publish all used to take every draft/review row. The generator inserts its
  // row as 'draft' before thumbnails, screenshots and translation, and the
  // gate-2 message only goes out after translation — so one tap published
  // articles nobody had seen, some without an image or RU.
  const add = (id: string, status: string, ready: boolean) => {
    const db = getDb();
    db.prepare("INSERT INTO keywords (id, query, status) VALUES (?, ?, 'generated')").run(`k-${id}`, `topic ${id}`);
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, status, ready_at)
       VALUES (?, ?, 'T', ?, ?, ${ready ? "datetime('now')" : "NULL"})`
    ).run(id, `k-${id}`, `slug-${id}`, status);
  };

  it("includes articles the operator has been shown", () => {
    add("shown-review", "review", true);
    add("shown-draft", "draft", true);
    expect(articlesReadyForReview().sort()).toEqual(["shown-draft", "shown-review"]);
  });

  it("excludes articles still generating or translating", () => {
    add("in-progress", "draft", false);
    expect(articlesReadyForReview()).toEqual([]);
  });

  it("excludes what is already published", () => {
    add("live", "published", true);
    expect(articlesReadyForReview()).toEqual([]);
  });
});

describe("recoverOrphanedReviews — articles a restart cut off before gate 2", () => {
  // The queues live in memory. A redeploy between "generated" and "translated"
  // leaves a draft/review row that never gets ready_at and never reaches the
  // operator — and Publish all now (rightly) ignores it. At boot the queues are
  // empty, so every such row is an orphan: send it through translation again,
  // which hands it to gate 2.
  const add = (id: string, status: string, ready: boolean) => {
    const db = getDb();
    db.prepare("INSERT INTO keywords (id, query, status) VALUES (?, ?, 'generated')").run(`k-${id}`, `topic ${id}`);
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, status, ready_at)
       VALUES (?, ?, 'T', ?, ?, ${ready ? "datetime('now')" : "NULL"})`
    ).run(id, `k-${id}`, `slug-${id}`, status);
  };

  it("re-enqueues every draft/review row that was never handed to the operator", () => {
    add("orphan-draft", "draft", false);
    add("orphan-review", "review", false);
    add("shown", "review", true);
    add("live", "published", false);
    const enqueue = vi.fn();
    const ids = recoverOrphanedReviews(enqueue);
    expect(ids.sort()).toEqual(["orphan-draft", "orphan-review"]);
    expect(enqueue).toHaveBeenCalledWith({ articleId: "orphan-draft", force: false, notifyWhenReady: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe("recoverInterruptedGenerations — the queue survives a redeploy", () => {
  // The generation queue lives in memory. Every redeploy during an Approve all
  // used to drop the rest of the batch: topics stuck 'approved', no article,
  // no message, and the approved headline lost.
  const kw = (id: string, job: object | null) =>
    getDb()
      .prepare("INSERT INTO keywords (id, query, status, generation_job) VALUES (?, ?, 'approved', ?)")
      .run(id, `topic ${id}`, job ? JSON.stringify(job) : null);
  const art = (id: string, keywordId: string, status: string, ready: boolean) =>
    getDb()
      .prepare(
        `INSERT INTO articles (id, keyword_id, title, slug, status, ready_at) VALUES (?, ?, 'T', ?, ?, ${ready ? "datetime('now')" : "NULL"})`
      )
      .run(id, keywordId, `slug-${id}`, status);
  const exists = (id: string) => Boolean(getDb().prepare("SELECT 1 FROM articles WHERE id = ?").get(id));

  it("re-queues every recorded job with its original query and headline", () => {
    kw("k1", { query: "topic k1", titleOverride: "The Approved Headline" });
    kw("k2", null);
    const enqueue = vi.fn(() => true);
    expect(recoverInterruptedGenerations(enqueue)).toEqual(["k1"]);
    expect(enqueue).toHaveBeenCalledWith({ keywordId: "k1", query: "topic k1", titleOverride: "The Approved Headline" });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("clears the record before re-queuing, so the queue can claim it again", () => {
    kw("k1", { query: "topic k1" });
    let seenDuringEnqueue: unknown = "unset";
    recoverInterruptedGenerations(() => {
      seenDuringEnqueue = (getDb().prepare("SELECT generation_job FROM keywords WHERE id = 'k1'").get() as { generation_job: unknown }).generation_job;
      return true;
    });
    expect(seenDuringEnqueue).toBeNull();
  });

  it("discards the half-written draft the killed job left behind", () => {
    // The generator inserts its row before thumbnails and screenshots. Keeping
    // it would mean two articles for one topic once the job reruns.
    kw("k1", { query: "topic k1" });
    art("half", "k1", "draft", false);
    recoverInterruptedGenerations(vi.fn(() => true));
    expect(exists("half")).toBe(false);
  });

  it("drops the job of a topic rejected while it was queued", () => {
    kw("k1", { query: "topic k1" });
    getDb().prepare("UPDATE keywords SET status = 'rejected' WHERE id = 'k1'").run();
    const enqueue = vi.fn(() => true);
    recoverInterruptedGenerations(enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    const job = getDb().prepare("SELECT generation_job FROM keywords WHERE id = 'k1'").get() as { generation_job: unknown };
    expect(job.generation_job).toBeNull();
  });

  it("drops the job of a topic that already has an article (e.g. a failed generation being reported)", () => {
    kw("k1", { query: "topic k1" });
    art("failed", "k1", "generation_failed", false);
    const enqueue = vi.fn(() => true);
    recoverInterruptedGenerations(enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    expect(exists("failed")).toBe(true);
  });

  it("survives a corrupt record without crashing boot", () => {
    getDb().prepare("INSERT INTO keywords (id, query, status, generation_job) VALUES ('k1', 'topic k1', 'approved', 'null')").run();
    const enqueue = vi.fn(() => true);
    expect(() => recoverInterruptedGenerations(enqueue)).not.toThrow();
    expect(enqueue).toHaveBeenCalledWith({ keywordId: "k1", query: "topic k1" });
  });

  it("replays recorded editing instructions", () => {
    kw("k1", { query: "topic k1", instructions: "Shorter intro" });
    const enqueue = vi.fn(() => true);
    recoverInterruptedGenerations(enqueue);
    expect(enqueue).toHaveBeenCalledWith({ keywordId: "k1", query: "topic k1", instructions: "Shorter intro" });
  });

  it("leaves finished articles alone", () => {
    kw("k1", { query: "topic k1" });
    art("shown", "k1", "review", true);
    art("live", "k1", "published", true);
    recoverInterruptedGenerations(vi.fn(() => true));
    expect(exists("shown")).toBe(true);
    expect(exists("live")).toBe(true);
  });
});

describe("articlesSyncedSince — what reached Framer before a sync failed", () => {
  it("returns the ids written to Framer at or after the given time", () => {
    const db = getDb();
    db.prepare("INSERT INTO framer_sync_state (item_id, hash, synced_at) VALUES ('new', 'h', '2026-10-15 12:00:05')").run();
    db.prepare("INSERT INTO framer_sync_state (item_id, hash, synced_at) VALUES ('old', 'h', '2026-10-15 11:00:00')").run();
    expect(articlesSyncedSince(["new", "old", "absent"], "2026-10-15 12:00:00")).toEqual(["new"]);
  });

  it("handles an empty list", () => {
    expect(articlesSyncedSince([], "2026-10-15 12:00:00")).toEqual([]);
  });
});

describe("unpublishArticleRow", () => {
  it("clears the announcement stamp along with the publish", () => {
    // A deploy firing mid-sync could announce an article that then failed to
    // sync. Left stamped, its eventual real publish was never announced.
    seedArticle("a1", "k1");
    getDb().prepare("UPDATE articles SET status = 'published', published_at = datetime('now'), announced_at = datetime('now') WHERE id = 'a1'").run();
    unpublishArticleRow("a1");
    const row = getDb().prepare("SELECT status, published_at, announced_at FROM articles WHERE id = 'a1'").get();
    expect(row).toEqual({ status: "review", published_at: null, announced_at: null });
  });
});

describe("describeFlags — what gate 2 tells the operator", () => {
  // Gate 2 used to print only the flag names ("⚠️ quality_issues"), so a real
  // broken link or an unsupported pricing claim looked exactly like routine
  // noise, and shipped with one tap.
  it("spells out the issues and the unsupported claims", () => {
    const lines = describeFlags({
      quality_issues: ["Broken internal link: /blog/nope"],
      ungrounded_claims: ["CRMChat costs $5 per seat"],
    });
    expect(lines.join("\n")).toContain("Broken internal link: /blog/nope");
    expect(lines.join("\n")).toContain("CRMChat costs $5 per seat");
  });

  it("names the plain flags in words", () => {
    expect(describeFlags({ thumbnail_missing: true, low_kb_match: true }).join("\n")).toMatch(/thumbnail/i);
    expect(describeFlags({ low_kb_match: true }).join("\n")).toMatch(/knowledge/i);
  });

  it("escapes what it quotes", () => {
    expect(describeFlags({ ungrounded_claims: ["<b>bold</b> & co"] }).join("")).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; co");
  });

  it("caps long lists and long items", () => {
    const lines = describeFlags({ ungrounded_claims: Array.from({ length: 10 }, (_, i) => `claim ${i} ${"x".repeat(400)}`) });
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.every((l) => l.length < 260)).toBe(true);
  });
});

describe("digests are tracked one by one", () => {
  const kw = (id: string, status = "pending") =>
    getDb().prepare("INSERT INTO keywords (id, query, status) VALUES (?, ?, ?)").run(id, `topic ${id}`, status);

  it("Approve all on an older digest finds that digest's titles, not the newest one's", () => {
    kw("old1"); kw("old2"); kw("new1");
    const older = recordDigest([{ keywordId: "old1", query: "topic old1", title: "topic old1" }, { keywordId: "old2", query: "topic old2", title: "topic old2" }]);
    recordDigest([{ keywordId: "new1", query: "topic new1", title: "topic new1" }]);
    expect(pendingInDigest(older)?.sort()).toEqual(["old1", "old2"]);
  });

  it("leaves out titles already decided", () => {
    kw("a"); kw("b", "approved");
    const id = recordDigest([{ keywordId: "a", query: "topic a", title: "topic a" }, { keywordId: "b", query: "topic b", title: "topic b" }]);
    expect(pendingInDigest(id)).toEqual(["a"]);
  });

  it("returns null for a button with no digest, or one no longer tracked", () => {
    expect(pendingInDigest("")).toBeNull();
    expect(pendingInDigest("never-recorded")).toBeNull();
  });

  it("stamps the proposed titles, and forgetting undoes it", () => {
    kw("a");
    const id = recordDigest([{ keywordId: "a", query: "topic a", title: "The Headline" }]);
    const proposed = () => (getDb().prepare("SELECT proposed_title FROM keywords WHERE id = 'a'").get() as { proposed_title: string | null }).proposed_title;
    expect(proposed()).toBe("The Headline");
    forgetDigest(id, ["a"]);
    expect(proposed()).toBeNull();
    expect(pendingInDigest(id)).toBeNull();
  });
});

describe("digestItems", () => {
  it("does not print a title twice when it is the topic itself", () => {
    // Every digest showed each title in bold and again in italics.
    expect(digestItems([{ keywordId: "k", query: "How to Tag Leads", title: "How to Tag Leads" }])).toEqual([
      { label: "How to Tag Leads" },
    ]);
  });

  it("still shows the topic under a title that differs", () => {
    expect(digestItems([{ keywordId: "k", query: "tag leads", title: "How to Tag Leads" }])).toEqual([
      { label: "How to Tag Leads", sub: "tag leads" },
    ]);
  });
});

describe("failureNotice", () => {
  it("offers Retry and Delete for a failed generation", () => {
    // It was a bare alert, so the operator could neither retry nor clear it
    // from Telegram, and the topic was simply used up.
    const n = failureNotice({ id: "a1", title: "Failed: How to <Tag> Leads", slug: "failed-a1" });
    expect(n.text).toContain("How to &lt;Tag&gt; Leads");
    const data = n.buttons.flat().map((b) => b.data);
    expect(data).toEqual(["rgn:a1", "del:a1"]);
  });
});

describe("digests sent before per-digest tracking", () => {
  it("lets a bare Approve-all button act on the legacy list until a tracked digest exists", async () => {
    // Tonight's digest may already be in the chat when this ships; its button
    // carries no id. Until the first tracked digest is sent, honour the old list.
    const { setSetting } = await import("./settings.js");
    getDb().prepare("INSERT INTO keywords (id, query, status) VALUES ('L1', 'topic L1', 'pending')").run();
    setSetting("digests", []);
    setSetting("lastDigestKeywordIds", ["L1"]);
    expect(pendingInDigest("")).toEqual(["L1"]);
    recordDigest([{ keywordId: "L1", query: "topic L1", title: "topic L1" }]);
    expect(pendingInDigest("")).toBeNull();
  });
});
