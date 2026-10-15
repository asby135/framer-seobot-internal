import { describe, it, expect, vi } from "vitest";
import { createGateHandlers, type GateDeps } from "./gates.js";

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    getKeyword: vi.fn(() => ({ id: "kw1", query: "a topic", status: "pending", proposed_title: "A Headline" })),
    approveKeyword: vi.fn(),
    rejectKeyword: vi.fn(),
    enqueueGeneration: vi.fn(() => true),
    getArticle: vi.fn(() => ({ id: "art1", title: "T", slug: "s", status: "review", content: "<p>body</p>" })),
    publishArticle: vi.fn(() => true),
    deleteArticle: vi.fn(),
    regenerateArticle: vi.fn(),
    syncToFramer: vi.fn(async () => ({ synced: 1, removed: 0, withLocales: true })),
    schedulePublish: vi.fn(),
    unpublishArticle: vi.fn(),
    syncClock: vi.fn(() => "2026-10-15 12:00:00"),
    syncedSince: vi.fn(() => []),
    pendingProposedKeywordIds: vi.fn(() => ["kw1", "kw2"]),
    reviewArticleIds: vi.fn(() => ["art1", "art2"]),
    recentTitles: () => [],
    proposeTitle: vi.fn(async () => "A Rerolled Headline"),
    saveProposedTitle: vi.fn(),
    editMessage: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
    progress: vi.fn(async () => {}),
    ...over,
  };
}

describe("onApproveTitle", () => {
  it("approves the keyword and enqueues generation with the pinned title", async () => {
    const d = deps();
    await createGateHandlers(d).onApproveTitle("kw1", 5);
    expect(d.approveKeyword).toHaveBeenCalledWith("kw1");
    expect(d.enqueueGeneration).toHaveBeenCalledWith({
      keywordId: "kw1",
      query: "a topic",
      titleOverride: "A Headline",
    });
  });

  it("is idempotent — a second tap does not enqueue twice", async () => {
    const d = deps({
      getKeyword: vi.fn(() => ({ id: "kw1", query: "q", status: "approved", proposed_title: "H" })),
    });
    await createGateHandlers(d).onApproveTitle("kw1", 5);
    expect(d.enqueueGeneration).not.toHaveBeenCalled();
  });

  it("does nothing for an unknown keyword", async () => {
    const d = deps({ getKeyword: vi.fn(() => undefined) });
    await createGateHandlers(d).onApproveTitle("nope", 5);
    expect(d.enqueueGeneration).not.toHaveBeenCalled();
  });

  it("generates without a pinned title when none was stored", async () => {
    const d = deps({
      getKeyword: vi.fn(() => ({ id: "kw1", query: "q", status: "pending", proposed_title: null })),
    });
    await createGateHandlers(d).onApproveTitle("kw1", 5);
    expect(d.enqueueGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ titleOverride: undefined })
    );
  });
});

describe("onRerollTitle", () => {
  it("proposes a new title excluding the previous one", async () => {
    const d = deps();
    await createGateHandlers(d).onRerollTitle("kw1", 5);
    expect(d.proposeTitle).toHaveBeenCalledWith("a topic", [], ["A Headline"]);
    expect(d.saveProposedTitle).toHaveBeenCalledWith("kw1", "A Rerolled Headline");
  });
});

describe("onPublish", () => {
  it("publishes, syncs, then arms the debounced deploy", async () => {
    const order: string[] = [];
    const d = deps({
      publishArticle: vi.fn(() => { order.push("publish"); return true; }),
      syncToFramer: vi.fn(async () => { order.push("sync"); return { synced: 1, removed: 0, withLocales: true }; }),
      schedulePublish: vi.fn(() => { order.push("deploy"); }),
    });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(order).toEqual(["publish", "sync", "deploy"]);
  });

  it("does not sync when the article was already published", async () => {
    // Tapping Publish twice must publish once.
    const d = deps({ publishArticle: vi.fn(() => false) });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(d.syncToFramer).not.toHaveBeenCalled();
    expect(d.schedulePublish).not.toHaveBeenCalled();
  });

  it("does not arm the deploy when the sync fails", async () => {
    // Deploying after a failed sync would publish a site missing the article.
    const d = deps({ syncToFramer: vi.fn(async () => { throw new Error("guard tripped"); }) });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(d.schedulePublish).not.toHaveBeenCalled();
  });

  it("alerts when the sync fails", async () => {
    const d = deps({ syncToFramer: vi.fn(async () => { throw new Error("guard tripped"); }) });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(d.alert).toHaveBeenCalledWith(expect.stringContaining("guard tripped"));
  });
});

describe("onPublish — rollback and locale reporting", () => {
  it("reverts the publish when the sync fails, so a retry can work", async () => {
    // Without this the article reads as published, so a second tap is a no-op
    // while it never reached Framer — recoverable only by a manual API call.
    const d = deps({ syncToFramer: vi.fn(async () => { throw new Error("guard tripped"); }) });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(d.unpublishArticle).toHaveBeenCalledWith("art1");
  });

  it("tells the operator the publish was reverted and can be retried", async () => {
    const d = deps({ syncToFramer: vi.fn(async () => { throw new Error("guard tripped"); }) });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(String((d.alert as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/retry/i);
  });

  it("does not revert a successful publish", async () => {
    const d = deps();
    await createGateHandlers(d).onPublish("art1", 5);
    expect(d.unpublishArticle).not.toHaveBeenCalled();
  });

  it("alerts when the sync silently dropped translations", async () => {
    const d = deps({
      syncToFramer: vi.fn(async () => ({ synced: 1, removed: 0, withLocales: false })),
    });
    await createGateHandlers(d).onPublish("art1", 5);
    expect(String((d.alert as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/translation/i);
  });
});

describe("bulk actions", () => {
  it("approve-all routes every pending proposal through the single-item path", async () => {
    const d = deps();
    await createGateHandlers(d).onApproveAll(0);
    expect(d.enqueueGeneration).toHaveBeenCalledTimes(2);
  });

  it("publish-all publishes every reviewable article", async () => {
    const d = deps();
    await createGateHandlers(d).onPublishAll(0);
    expect(d.publishArticle).toHaveBeenCalledTimes(2);
  });

  it("approve-all is a no-op when nothing is pending", async () => {
    const d = deps({ pendingProposedKeywordIds: vi.fn(() => []) });
    await createGateHandlers(d).onApproveAll(0);
    expect(d.enqueueGeneration).not.toHaveBeenCalled();
  });
});

describe("onDelete / onRegenerate", () => {
  it("deletes the article", async () => {
    const d = deps();
    await createGateHandlers(d).onDelete("art1", 5);
    expect(d.deleteArticle).toHaveBeenCalledWith("art1");
  });

  it("regenerates the article", async () => {
    const d = deps();
    await createGateHandlers(d).onRegenerate("art1", 5);
    expect(d.regenerateArticle).toHaveBeenCalledWith("art1");
  });

  it("refuses to regenerate an already-published article", async () => {
    // A double-tap otherwise runs two full generations; the second collides on
    // the unique slug and lands as generation_failed.
    const d = deps({
      getArticle: vi.fn(() => ({ id: "art1", title: "T", slug: "s", status: "published", content: "x" })),
    });
    await createGateHandlers(d).onRegenerate("art1", 5);
    expect(d.regenerateArticle).not.toHaveBeenCalled();
  });

  it("refuses to delete an already-published article", async () => {
    const d = deps({
      getArticle: vi.fn(() => ({ id: "art1", title: "T", slug: "s", status: "published", content: "x" })),
    });
    await createGateHandlers(d).onDelete("art1", 5);
    expect(d.deleteArticle).not.toHaveBeenCalled();
  });

  it("ignores an unknown article", async () => {
    const d = deps({ getArticle: vi.fn(() => undefined) });
    await createGateHandlers(d).onDelete("nope", 5);
    expect(d.deleteArticle).not.toHaveBeenCalled();
  });
});

describe("bulk actions with nothing to act on", () => {
  it("says so rather than silently doing nothing on approve-all", async () => {
    // "Approve-all requested count: 0" and no other feedback reads as a broken
    // bot — the operator taps again and gets the same silence.
    const d = deps({ pendingProposedKeywordIds: () => [] });
    const h = createGateHandlers(d);
    await h.onApproveAll(0);
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/nothing left to approve/i));
  });

  it("says so on publish-all too", async () => {
    const d = deps({ reviewArticleIds: () => [] });
    const h = createGateHandlers(d);
    await h.onPublishAll(0);
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/no articles are waiting/i));
  });
});

describe("acknowledging a tapped button", () => {
  const msgs = (d: ReturnType<typeof deps>) =>
    (d.progress as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

  it("says generation has started when a title is approved", async () => {
    // Generation takes minutes. Without this the operator taps and sees nothing
    // until the draft lands, which is indistinguishable from a dead button.
    const d = deps();
    await createGateHandlers(d).onApproveTitle("k1", 0);
    expect(msgs(d).join(" ")).toMatch(/approved/i);
  });

  it("says nothing when the approval was a no-op", async () => {
    const d = deps({ getKeyword: () => ({ id: "k1", query: "q", status: "approved", proposed_title: null }) });
    await createGateHandlers(d).onApproveTitle("k1", 0);
    expect(d.progress).not.toHaveBeenCalled();
  });

  it("sends ONE summary for approve-all, not one message per title", async () => {
    const d = deps({ pendingProposedKeywordIds: () => ["k1", "k2", "k3"] });
    await createGateHandlers(d).onApproveAll(0);
    expect(msgs(d)).toHaveLength(1);
    expect(msgs(d)[0]).toMatch(/3 titles/);
  });

  it("sends ONE summary for publish-all", async () => {
    const d = deps({ reviewArticleIds: () => ["a1", "a2"] });
    await createGateHandlers(d).onPublishAll(0);
    expect(msgs(d)).toHaveLength(1);
    expect(msgs(d)[0]).toMatch(/2 articles/);
  });

  it("reports the rerolled title, which previously only reached the log", async () => {
    // A silent reroll changed what would be written, so the operator approved a
    // headline they had never seen.
    const d = deps({ proposeTitle: vi.fn(async () => "A Clearer Title") });
    await createGateHandlers(d).onRerollTitle("k1", 0);
    expect(msgs(d).join(" ")).toContain("A Clearer Title");
  });

  it("confirms a rejection", async () => {
    const d = deps();
    await createGateHandlers(d).onRejectTopic("k1", 0);
    expect(msgs(d).join(" ")).toMatch(/rejected/i);
  });

  it("says the sync has started when publishing one article", async () => {
    const d = deps();
    await createGateHandlers(d).onPublish("a1", 0);
    expect(msgs(d).join(" ")).toMatch(/publishing/i);
  });
});

describe("Publish-all syncs the whole batch in one go", () => {
  // Seen 2026-09-19: Framer's session takes ~70s to accept its first write
  // after connecting. Publish-all synced each article on its own connection,
  // so 26 articles paid that warm-up 26 times — about 50 minutes for what is
  // one batch of writes.
  it("marks every article published, then syncs ONCE", async () => {
    const order: string[] = [];
    const d = deps({
      reviewArticleIds: vi.fn(() => ["a1", "a2", "a3"]),
      publishArticle: vi.fn((id: string) => { order.push(`publish:${id}`); return true; }),
      syncToFramer: vi.fn(async () => { order.push("sync"); return { synced: 3, removed: 0, withLocales: true }; }),
    });
    await createGateHandlers(d).onPublishAll(0);
    expect(order).toEqual(["publish:a1", "publish:a2", "publish:a3", "sync"]);
    expect(d.schedulePublish).toHaveBeenCalledTimes(1);
  });

  it("rolls back every article it marked when the sync fails, and says so once", async () => {
    // Leaving them published would strand them: they read as live, so another
    // tap is a no-op, but they never reached Framer.
    const d = deps({
      reviewArticleIds: vi.fn(() => ["a1", "a2", "a3"]),
      syncToFramer: vi.fn(async () => { throw new Error("Framer's session was not ready"); }),
    });
    await createGateHandlers(d).onPublishAll(0);
    expect((d.unpublishArticle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["a1", "a2", "a3"]);
    expect(d.schedulePublish).not.toHaveBeenCalled();
    expect(d.alert).toHaveBeenCalledTimes(1);
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/3 articles.*still in review/i));
  });

  it("does not roll back an article it did not mark", async () => {
    // a2 was already published by a tap that raced this one; it is not ours to undo.
    const d = deps({
      reviewArticleIds: vi.fn(() => ["a1", "a2"]),
      publishArticle: vi.fn((id: string) => id !== "a2"),
      syncToFramer: vi.fn(async () => { throw new Error("nope"); }),
    });
    await createGateHandlers(d).onPublishAll(0);
    expect((d.unpublishArticle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["a1"]);
  });

  it("does not sync at all when nothing was publishable", async () => {
    const d = deps({ publishArticle: vi.fn(() => false) });
    await createGateHandlers(d).onPublishAll(0);
    expect(d.syncToFramer).not.toHaveBeenCalled();
  });

  it("still warns when the batch went out without translations", async () => {
    const d = deps({ syncToFramer: vi.fn(async () => ({ synced: 2, removed: 0, withLocales: false })) });
    await createGateHandlers(d).onPublishAll(0);
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/without translations/i));
  });
});

describe("a sync that fails partway", () => {
  // The sync writes in batches and records each batch as it lands. When a
  // later batch failed, every article was rolled back to review — including
  // those already in Framer. A deploy before the next sync shipped them as
  // live while the database said review; the next sync then removed them.
  it("keeps the articles that reached Framer published, rolls back the rest, and deploys", async () => {
    const d = deps({
      reviewArticleIds: vi.fn(() => ["a1", "a2", "a3"]),
      syncToFramer: vi.fn(async () => { throw new Error("batch 2 refused"); }),
      syncedSince: vi.fn((ids: string[]) => ids.filter((id) => id === "a1")),
    });
    await createGateHandlers(d).onPublishAll(0);
    expect((d.unpublishArticle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["a2", "a3"]);
    expect(d.schedulePublish).toHaveBeenCalledOnce();
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/1 of 3.*2 still in review/i));
  });

  it("asks what landed since the sync STARTED, not since some earlier one", async () => {
    const d = deps({ syncToFramer: vi.fn(async () => { throw new Error("x"); }) });
    await createGateHandlers(d).onPublishAll(0);
    expect(d.syncedSince).toHaveBeenCalledWith(["art1", "art2"], "2026-10-15 12:00:00");
  });

  it("does not deploy when nothing landed", async () => {
    const d = deps({ syncToFramer: vi.fn(async () => { throw new Error("x"); }) });
    await createGateHandlers(d).onPublishAll(0);
    expect(d.schedulePublish).not.toHaveBeenCalled();
  });

  it("keeps a single publish whose article landed before the failure", async () => {
    const d = deps({
      syncToFramer: vi.fn(async () => { throw new Error("a later batch failed"); }),
      syncedSince: vi.fn((ids: string[]) => ids),
    });
    await createGateHandlers(d).onPublish("art1", 0);
    expect(d.unpublishArticle).not.toHaveBeenCalled();
    expect(d.schedulePublish).toHaveBeenCalledOnce();
  });
});

describe("when the sync clock is read", () => {
  it("reads it right after marking the article, before any Telegram round-trip", async () => {
    // A sync already running could pick the article up and write it while the
    // "Publishing…" message was in flight. Reading the clock after that made
    // the write look older than the sync, so a later failure rolled back an
    // article that was in Framer.
    const order: string[] = [];
    const d = deps({
      progress: vi.fn(async () => { order.push("progress"); }),
      syncClock: vi.fn(() => { order.push("clock"); return "t"; }),
    });
    await createGateHandlers(d).onPublish("art1", 0);
    expect(order.indexOf("clock")).toBeLessThan(order.indexOf("progress"));
  });
});

describe("approving when the queue refuses the topic", () => {
  it("does not claim generation started", async () => {
    const d = deps({ enqueueGeneration: vi.fn(() => false) });
    await createGateHandlers(d).onApproveTitle("kw1", 5);
    const said = (d.progress as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(said.some((m) => /writing/i.test(m))).toBe(false);
    expect(said.some((m) => /already/i.test(m))).toBe(true);
  });
});
