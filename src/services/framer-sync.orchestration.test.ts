import { describe, it, expect, vi } from "vitest";
import { syncCollection, previewSync, type CollectionPort, type CollectionItem } from "./framer-sync.js";

/**
 * Integration-shaped tests for the destructive path.
 *
 * The guards were previously only unit-tested as predicates, with arguments
 * hand-passed by the test. That missed the bug that mattered: syncToFramer
 * measured `framerCount - backendCount` but deleted the ID set difference.
 * With 308 items on both sides whose IDs had diverged, the guard returned ok
 * while removeItems deleted all 308 live articles.
 *
 * These tests drive the real orchestration through a fake port, so ordering
 * and the quantity actually guarded are both asserted.
 */

const item = (id: string): CollectionItem => ({
  id,
  slug: `slug-${id}`,
  fieldData: { title: { type: "string", value: `T ${id}` } },
});

function fakePort(existingIds: string[]): CollectionPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    id: "bound-collection",
    async getItemIds() {
      calls.push("getItemIds");
      return existingIds;
    },
    async getFields() {
      calls.push("getFields");
      return [];
    },
    async setFields() {
      calls.push("setFields");
    },
    async addItems(items) {
      calls.push(`addItems(${items.length})`);
    },
    async removeItems(ids) {
      calls.push(`removeItems(${ids.length})`);
    },
    async setPluginData() {
      calls.push("setPluginData");
    },
  };
}

const locales = [{ id: "ruId", code: "ru-RU", slug: "ru" }];
const opts = { collectionId: "bound-collection", maxRemovalShare: 0.2, fields: [] };

describe("syncCollection — the wipe guard measures what is actually removed", () => {
  it("refuses when IDs have fully diverged even though the counts match", async () => {
    // The exact shape that defeated the old count-based guard.
    const port = fakePort(Array.from({ length: 308 }, (_, i) => `old-${i}`));
    const payload = Array.from({ length: 308 }, (_, i) => item(`new-${i}`));

    await expect(syncCollection(port, payload, ["ru"], locales, opts)).rejects.toThrow(/remove/i);
    expect(port.calls.join(",")).not.toContain("removeItems");
  });

  it("refuses before any destructive call is made", async () => {
    const port = fakePort(Array.from({ length: 100 }, (_, i) => `old-${i}`));
    await expect(
      syncCollection(port, [item("new-1")], ["ru"], locales, opts)
    ).rejects.toThrow();
    expect(port.calls).not.toContain("removeItems(99)");
    expect(port.calls.some((c) => c.startsWith("addItems"))).toBe(false);
  });

  it("refuses when the backend is empty and Framer holds items", async () => {
    const port = fakePort(["a", "b", "c"]);
    await expect(syncCollection(port, [], ["ru"], locales, opts)).rejects.toThrow(/0 published/i);
  });

  it("allows a normal incremental sync and removes only genuinely stale ids", async () => {
    const port = fakePort(["a", "b", "c"]);
    const payload = [item("a"), item("b"), item("d")]; // c stale, d new
    const res = await syncCollection(port, payload, ["ru"], locales, opts);

    expect(port.calls).toContain("removeItems(1)");
    expect(res.removed).toBe(1);
    expect(res.synced).toBe(3);
  });

  it("removes before adding, so a reused slug cannot collide", async () => {
    const port = fakePort(["a", "b", "c"]);
    await syncCollection(port, [item("a"), item("b"), item("d")], ["ru"], locales, opts);

    const removeAt = port.calls.findIndex((c) => c.startsWith("removeItems"));
    const addAt = port.calls.findIndex((c) => c.startsWith("addItems"));
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeLessThan(addAt);
  });

  it("checks the guard before removing", async () => {
    const port = fakePort(["a", "b", "c"]);
    await syncCollection(port, [item("a"), item("b"), item("c")], ["ru"], locales, opts);
    // Nothing stale, so nothing removed at all.
    expect(port.calls.some((c) => c.startsWith("removeItems"))).toBe(false);
  });

  it("refuses a collection whose id is not the configured one", async () => {
    const port = { ...fakePort([]), id: "some-other-collection" };
    await expect(
      syncCollection(port, [item("a")], ["ru"], locales, opts)
    ).rejects.toThrow(/internal link/i);
  });

  it("chunks large payloads rather than sending one huge call", async () => {
    const port = fakePort([]);
    const payload = Array.from({ length: 45 }, (_, i) => item(`a${i}`));
    await syncCollection(port, payload, ["ru"], locales, opts);

    // Batches are small on purpose: Framer times out a method call at 120s and
    // resolves internal links per item at ingest, so a large batch is what
    // exceeded it. 45 items go out as 9 calls of 5.
    const adds = port.calls.filter((c) => c.startsWith("addItems"));
    expect(adds.length).toBe(9);
    expect(new Set(adds)).toEqual(new Set(["addItems(5)"]));
  });
});

describe("syncCollection — locale fallback", () => {
  it("does not silently strip translations on an arbitrary error", async () => {
    // Catching everything meant a rate limit or network blip could blank RU
    // across all 308 articles with only a log line.
    const port = fakePort([]);
    port.addItems = vi.fn(async () => {
      throw new Error("rate limited");
    });

    await expect(syncCollection(port, [item("a")], ["ru"], locales, opts)).rejects.toThrow(
      /rate limited/
    );
  });

  it("falls back without locales only for a locale-shaped failure, and reports it", async () => {
    const port = fakePort([]);
    let first = true;
    port.addItems = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error("Unknown locale id for variable reference");
      }
    });

    const res = await syncCollection(port, [item("a")], ["ru"], locales, opts);
    expect(res.withLocales).toBe(false);
  });
});

describe("previewSync — see the arithmetic before granting a write", () => {
  const item = (id: string): CollectionItem => ({
    id, slug: `slug-${id}`, fieldData: { title: { type: "string", value: id } },
  });
  const locales = [{ id: "ruId", code: "ru-RU", slug: "ru" }];
  const opts = { collectionId: "c1", maxRemovalShare: 0.2, fields: [] };

  it("reports the guard would refuse a full-corpus removal", () => {
    const existing = Array.from({ length: 308 }, (_, i) => `old-${i}`);
    const payload = Array.from({ length: 308 }, (_, i) => item(`new-${i}`));
    const p = previewSync(existing, payload, ["ru"], locales, opts);

    expect(p.wouldProceed).toBe(false);
    expect(p.staleCount).toBe(308);
    expect(p.guard.ok).toBe(false);
  });

  it("reports a healthy incremental sync", () => {
    const p = previewSync(["a", "b"], [item("a"), item("b"), item("c")], ["ru"], locales, opts);
    expect(p.wouldProceed).toBe(true);
    expect(p.staleCount).toBe(0);
    expect(p.newCount).toBe(1);
    expect(p.backendCount).toBe(3);
    expect(p.framerCount).toBe(2);
  });

  it("surfaces the resolved locale mapping so a silent RU drop is visible", () => {
    const p = previewSync([], [item("a")], ["ru"], locales, opts);
    expect(p.localeMapping).toEqual({ ru: "ruId" });
  });

  it("shows an empty mapping when no locale resolves", () => {
    const p = previewSync([], [item("a")], ["fr"], locales, opts);
    expect(p.localeMapping).toEqual({});
  });

  it("caps the stale id list so a large diff cannot flood the response", () => {
    const existing = Array.from({ length: 100 }, (_, i) => `old-${i}`);
    const p = previewSync(existing, [item("new")], ["ru"], locales, opts);
    expect(p.staleCount).toBe(100);
    expect(p.staleIds.length).toBeLessThanOrEqual(25);
  });
});

/**
 * Incremental sync.
 *
 * Every publish used to re-upload the entire corpus. Framer resolves internal
 * links at ingest, so per-item cost is real work — at roughly 6s an item a
 * 310-article corpus ran ~30 minutes and blew the API's 120s per-call timeout,
 * which is what "addManagedCollectionItems2 timed out after 120000ms" was.
 */
function portWith(
  existingIds: string[],
  over: { fields?: Array<{ id: string; name: string; type: string }>; failAdd?: boolean } = {}
): CollectionPort & { added: number[] } {
  const added: number[] = [];
  return {
    added,
    id: "bound-collection",
    async getItemIds() {
      return existingIds;
    },
    async getFields() {
      return (over.fields ?? []) as never;
    },
    async setFields() {},
    async addItems(items) {
      if (over.failAdd) throw new Error("boom");
      added.push(items.length);
    },
    async removeItems() {},
    async setPluginData() {},
  };
}

const three = [item("a"), item("b"), item("c")];

/** Run one sync and return the fingerprints it recorded. */
async function syncOnce(
  port: CollectionPort,
  known: Map<string, string>,
  extra: Record<string, unknown> = {}
): Promise<Map<string, string>> {
  const recorded = new Map(known);
  await syncCollection(port, three, ["ru"], locales, {
    ...opts,
    syncedHashes: known,
    recordSynced: (entries) => {
      for (const [id, hash] of entries) recorded.set(id, hash);
    },
    ...extra,
  });
  return recorded;
}

describe("syncCollection — incremental writes", () => {
  it("writes everything on the first sync, when nothing is known", async () => {
    const port = portWith(["a", "b", "c"]);
    await syncOnce(port, new Map());
    expect(port.added).toEqual([3]);
  });

  it("writes nothing on a second sync when no content changed", async () => {
    const known = await syncOnce(portWith(["a", "b", "c"]), new Map());
    const port = portWith(["a", "b", "c"]);
    await syncOnce(port, known);
    expect(port.added).toEqual([]);
  });

  it("writes only the item whose content changed", async () => {
    const known = await syncOnce(portWith(["a", "b", "c"]), new Map());
    const port = portWith(["a", "b", "c"]);
    const edited = [item("a"), { ...item("b"), slug: "renamed" }, item("c")];
    await syncCollection(port, edited, ["ru"], locales, {
      ...opts,
      syncedHashes: known,
      recordSynced: () => {},
    });
    expect(port.added).toEqual([1]);
  });

  it("rewrites an item Framer does not have, even when the fingerprint matches", async () => {
    // Framer's own item ids are the authority on existence. A hash store that
    // could suppress a MISSING article would lose it permanently — the whole
    // point of testing `present` before the fingerprint.
    const known = await syncOnce(portWith(["a", "b", "c"]), new Map());
    const port = portWith(["a", "b"]); // c deleted in the Framer UI
    await syncOnce(port, known);
    expect(port.added).toEqual([1]);
  });

  it("rewrites everything when force is set", async () => {
    const known = await syncOnce(portWith(["a", "b", "c"]), new Map());
    const port = portWith(["a", "b", "c"]);
    await syncOnce(port, known, { force: true });
    expect(port.added).toEqual([3]);
  });

  it("rewrites everything when a field is added, since old items lack it", async () => {
    const known = await syncOnce(portWith(["a", "b", "c"]), new Map());
    const existing = [{ id: "title", name: "Title", type: "string" }];
    const port = portWith(["a", "b", "c"], { fields: existing });
    await syncCollection(port, three, ["ru"], locales, {
      ...opts,
      fields: [...existing, { id: "summary", name: "Summary", type: "string" }] as never,
      syncedHashes: known,
      recordSynced: () => {},
    });
    expect(port.added).toEqual([3]);
  });

  it("records no fingerprints when the write throws", async () => {
    // Recording before the write landed would mark items synced that Framer
    // never received, and the next run would skip them forever.
    const recorded: Array<[string, string]> = [];
    const port = portWith(["a", "b", "c"], { failAdd: true });
    await expect(
      syncCollection(port, three, ["ru"], locales, {
        ...opts,
        syncedHashes: new Map(),
        recordSynced: (e) => recorded.push(...e),
      })
    ).rejects.toThrow();
    expect(recorded).toEqual([]);
  });

  it("reports the corpus size and the number actually written separately", async () => {
    const known = await syncOnce(portWith(["a", "b", "c"]), new Map());
    const res = await syncCollection(portWith(["a", "b", "c"]), three, ["ru"], locales, {
      ...opts,
      syncedHashes: known,
      recordSynced: () => {},
    });
    expect(res.synced).toBe(3);
    expect(res.written).toBe(0);
  });
});
