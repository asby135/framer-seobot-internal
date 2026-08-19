import { describe, it, expect, vi } from "vitest";
import { createGateHandlers, type GateDeps } from "./gates.js";

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    getKeyword: vi.fn(() => ({ id: "kw1", query: "a topic", status: "pending", proposed_title: "A Headline" })),
    approveKeyword: vi.fn(),
    rejectKeyword: vi.fn(),
    enqueueGeneration: vi.fn(),
    getArticle: vi.fn(() => ({ id: "art1", title: "T", slug: "s", status: "review", content: "<p>body</p>" })),
    publishArticle: vi.fn(() => true),
    deleteArticle: vi.fn(),
    regenerateArticle: vi.fn(),
    syncToFramer: vi.fn(async () => ({ synced: 1, removed: 0, withLocales: true })),
    schedulePublish: vi.fn(),
    recentTitles: () => [],
    proposeTitle: vi.fn(async () => "A Rerolled Headline"),
    saveProposedTitle: vi.fn(),
    editMessage: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
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

  it("ignores an unknown article", async () => {
    const d = deps({ getArticle: vi.fn(() => undefined) });
    await createGateHandlers(d).onDelete("nope", 5);
    expect(d.deleteArticle).not.toHaveBeenCalled();
  });
});
