import { describe, it, expect, vi } from "vitest";
import { syncCollection, previewSync, withFreshSessionRetry, type CollectionPort, type CollectionItem } from "./framer-sync.js";

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

/** A port whose addItems hangs for any batch matching `poison`. */
function failingOn(poison: (batch: CollectionItem[]) => boolean): CollectionPort {
  return {
    id: "bound-collection",
    async getItemIds() {
      return [];
    },
    async getFields() {
      return [];
    },
    async setFields() {},
    async addItems(items) {
      if (poison(items as CollectionItem[])) {
        throw new Error('Method "addManagedCollectionItems2" timed out after 120000ms');
      }
    },
    async removeItems() {},
    async setPluginData() {},
  };
}

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
  it("writes everything into a collection Framer holds nothing in", async () => {
    const port = portWith([]);
    await syncOnce(port, new Map());
    expect(port.added).toEqual([3]);
  });

  it("ADOPTS items Framer already holds rather than rewriting them", async () => {
    // The first run after this feature shipped would otherwise rewrite the
    // whole corpus to learn what is in it — ~6s an item, half an hour for 310,
    // past the per-call timeout. The items are already there.
    const port = portWith(["a", "b", "c"]);
    const known = await syncOnce(port, new Map());
    expect(port.added).toEqual([]);
    expect(known.size).toBe(3);
  });

  it("still writes what Framer is missing while adopting the rest", async () => {
    // Exactly the divergence a reverted publish leaves behind: the backend says
    // published, Framer never received the item.
    const port = portWith(["a", "b"]);
    await syncOnce(port, new Map());
    expect(port.added).toEqual([1]);
  });

  it("records each batch as it lands, so a timeout keeps the progress made", async () => {
    // Recording once at the end meant a partial failure discarded every batch
    // that had already landed, and a corpus too big for one run could never
    // finish — every retry restarted from zero.
    const recorded: Array<[string, string]> = [];
    const many = Array.from({ length: 12 }, (_, i) => item(`m${i}`));
    // m7 is poison: any call carrying it hangs, exactly like the real timeout.
    const port = failingOn((batch) => batch.some((b) => b.id === "m7"));

    await expect(
      syncCollection(port, many, ["ru"], locales, {
        ...opts,
        syncedHashes: new Map(),
        recordSynced: (e) => recorded.push(...e),
      })
    ).rejects.toThrow(/timed out/);

    // m0-m4 as a batch, then m5 and m6 individually once the batch carrying
    // m7 fell back to one at a time. m7 itself never lands.
    expect(recorded.map(([id]) => id)).toEqual([
      "m0", "m1", "m2", "m3", "m4", "m5", "m6",
    ]);
  });

  it("falls back to one item per call, so a batch-size limit does not fail the publish", async () => {
    // If the batch call is the problem rather than any single item, splitting
    // it lets every item through instead of losing the whole publish.
    const recorded: Array<[string, string]> = [];
    const many = Array.from({ length: 12 }, (_, i) => item(`m${i}`));
    const port = failingOn((batch) => batch.length > 1);

    await syncCollection(port, many, ["ru"], locales, {
      ...opts,
      syncedHashes: new Map(),
      recordSynced: (e) => recorded.push(...e),
    });
    expect(recorded).toHaveLength(12);
  });

  it("records no fingerprints when the write throws", async () => {
    // Recording before the write landed would mark items synced that Framer
    // never received, and the next run would skip them forever.
    const recorded: Array<[string, string]> = [];
    const port = portWith([], { failAdd: true }); // empty, so nothing is adopted
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
    const known = await syncOnce(portWith([]), new Map());
    const res = await syncCollection(portWith(["a", "b", "c"]), three, ["ru"], locales, {
      ...opts,
      syncedHashes: known,
      recordSynced: () => {},
    });
    expect(res.synced).toBe(3);
    expect(res.written).toBe(0);
  });
});

describe("syncCollection — Framer's session not being ready is not the item's fault", () => {
  // Seen in production 2026-09-18/19: every publish failed on its first write
  // with this message, a DIFFERENT article each time, while a manual publish in
  // the Framer editor went through. Framer raises it when its hosted session
  // for the project has not finished loading the project's code modules — so
  // it says nothing about the item, and waiting is the fix.
  const NOT_READY = "ensureComponentsInLoader: Modules store not ready in time.";

  function flakyPort(failures: number, message = NOT_READY) {
    const port = fakePort([]);
    let left = failures;
    port.addItems = async (items) => {
      port.calls.push(`addItems(${items.length})`);
      if (left-- > 0) throw new Error(message);
    };
    return port;
  }
  const sleeps: number[] = [];
  const retryOpts = () => {
    sleeps.length = 0;
    return { ...opts, sleep: async (ms: number) => void sleeps.push(ms) };
  };

  it("waits and retries on the same connection, and the sync succeeds", async () => {
    const port = flakyPort(2);
    const recorded: string[] = [];
    const result = await syncCollection(port, [item("a")], ["ru"], locales, {
      ...retryOpts(),
      recordSynced: (entries) => recorded.push(...entries.map((e) => e[0])),
    });
    expect(port.calls.filter((c) => c.startsWith("addItems"))).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]); // backs off
    expect(recorded).toEqual(["a"]);
    expect(result.synced).toBe(1);
  });

  it("gives up after a bounded number of attempts and says it is Framer, not the item", async () => {
    const port = flakyPort(99);
    await expect(syncCollection(port, [item("a")], ["ru"], locales, retryOpts())).rejects.toThrow(
      /Framer's session.*not ready/i
    );
    expect(port.calls.filter((c) => c.startsWith("addItems"))).toHaveLength(4);
  });

  it("does not split a batch into single items over it", async () => {
    // Isolation exists to name a bad ITEM. This error is about the session, so
    // splitting five items would only multiply the waiting by five.
    const port = flakyPort(99);
    const payload = ["a", "b", "c"].map(item);
    await expect(syncCollection(port, payload, ["ru"], locales, retryOpts())).rejects.toThrow();
    expect(port.calls.filter((c) => c.startsWith("addItems"))).toEqual(
      Array(4).fill("addItems(3)")
    );
  });

  it("does not retry an error that IS about the item", async () => {
    const port = flakyPort(99, "Duplicate slug");
    await expect(syncCollection(port, [item("a")], ["ru"], locales, retryOpts())).rejects.toThrow(
      "Duplicate slug"
    );
    expect(port.calls.filter((c) => c.startsWith("addItems"))).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });
});

describe("withFreshSessionRetry — when Framer says a new session would work", () => {
  // framer-api marks some errors `retryable`: the server's own statement that
  // the session crashed, closed or was recycled and that re-issuing on a fresh
  // one is expected to succeed. Distinct from "not ready", which is waited out
  // on the SAME connection.
  const retryable = Object.assign(new Error("session recycled"), { retryable: true });

  it("runs the whole sync again on a fresh session, once", async () => {
    const run = vi.fn().mockRejectedValueOnce(retryable).mockResolvedValueOnce("ok");
    await expect(withFreshSessionRetry(run, (e) => (e as { retryable?: boolean }).retryable === true)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not loop: a second retryable failure is final", async () => {
    const run = vi.fn().mockRejectedValue(retryable);
    await expect(withFreshSessionRetry(run, () => true)).rejects.toThrow("session recycled");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves every other error alone", async () => {
    const run = vi.fn().mockRejectedValue(new Error("would remove 308 items"));
    await expect(withFreshSessionRetry(run, () => false)).rejects.toThrow(/308/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
