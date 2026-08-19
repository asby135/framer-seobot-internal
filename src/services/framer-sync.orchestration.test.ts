import { describe, it, expect, vi } from "vitest";
import { syncCollection, type CollectionPort, type CollectionItem } from "./framer-sync.js";

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

    const adds = port.calls.filter((c) => c.startsWith("addItems"));
    expect(adds.length).toBeGreaterThan(1);
    expect(adds).toEqual(["addItems(20)", "addItems(20)", "addItems(5)"]);
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
