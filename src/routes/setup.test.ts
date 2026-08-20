import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Multiple named API keys.
 *
 * The single-active-key design ran `DELETE FROM api_keys` on every mint, so
 * issuing a key for the CLI silently logged the plugin out, and vice versa.
 * With two consumers that is a footgun rather than a security property: it
 * caused three separate "Invalid API key" incidents in one afternoon.
 *
 * Keys are now labelled. Minting a label replaces only that label.
 */

const SECRET = "test-setup-secret";
let getDb: typeof import("../db/index.js").getDb;
let setup: typeof import("./setup.js").setup;
let hashKey: typeof import("../lib/auth.js").hashKey;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-setup-")), "test.db");
  process.env.SETUP_SECRET = SECRET;
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ setup } = await import("./setup.js"));
  ({ hashKey } = await import("../lib/auth.js"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM api_keys").run();
});

const mint = (body: Record<string, unknown>) =>
  setup.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const keyOf = async (res: Response) => ((await res.json()) as { api_key: string }).api_key;
const labels = () =>
  (getDb().prepare("SELECT label FROM api_keys ORDER BY label").all() as { label: string }[]).map(
    (r) => r.label
  );

describe("POST /api/setup", () => {
  it("rejects a wrong secret", async () => {
    expect((await mint({ secret: "nope" })).status).toBe(403);
  });

  it("mints a key under the default label", async () => {
    const res = await mint({ secret: SECRET });
    expect(res.status).toBe(200);
    expect(await keyOf(res)).toHaveLength(43);
    expect(labels()).toEqual(["default"]);
  });

  it("mints independent keys for different labels", async () => {
    await mint({ secret: SECRET, label: "plugin" });
    await mint({ secret: SECRET, label: "cli" });
    expect(labels()).toEqual(["cli", "plugin"]);
  });

  it("does NOT invalidate other labels — the whole point", async () => {
    const pluginKey = await keyOf(await mint({ secret: SECRET, label: "plugin" }));
    await mint({ secret: SECRET, label: "cli" });

    const row = getDb()
      .prepare("SELECT id FROM api_keys WHERE key_hash = ?")
      .get(hashKey(pluginKey));
    expect(row).toBeDefined();
  });

  it("replaces a key when the same label is minted again", async () => {
    const first = await keyOf(await mint({ secret: SECRET, label: "cli" }));
    const second = await keyOf(await mint({ secret: SECRET, label: "cli" }));

    expect(second).not.toBe(first);
    expect(labels()).toEqual(["cli"]);
    expect(
      getDb().prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(hashKey(first))
    ).toBeUndefined();
  });

  it("rejects a label that is not a simple name", async () => {
    expect((await mint({ secret: SECRET, label: "a b/c" })).status).toBe(400);
  });

  it("caps the number of labels so keys cannot accumulate unbounded", async () => {
    for (let i = 0; i < 10; i++) await mint({ secret: SECRET, label: `k${i}` });
    expect((await mint({ secret: SECRET, label: "one-too-many" })).status).toBe(400);
  });
});

describe("GET /api/setup/keys", () => {
  it("lists labels without ever exposing a key", async () => {
    await mint({ secret: SECRET, label: "plugin" });
    const res = await setup.request("/keys");
    const body = await res.text();

    expect(body).toContain("plugin");
    expect(body).not.toMatch(/api_key|key_hash/);
  });
});

describe("DELETE /api/setup/keys/:label", () => {
  it("revokes one label and leaves the others", async () => {
    await mint({ secret: SECRET, label: "plugin" });
    await mint({ secret: SECRET, label: "cli" });

    const res = await setup.request("/keys/cli", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(labels()).toEqual(["plugin"]);
  });

  it("404s for a label that does not exist", async () => {
    expect((await setup.request("/keys/ghost", { method: "DELETE" })).status).toBe(404);
  });

  it("refuses to revoke the last remaining key", async () => {
    // Otherwise you lock yourself out and need SETUP_SECRET to recover.
    await mint({ secret: SECRET, label: "only" });
    const res = await setup.request("/keys/only", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(labels()).toEqual(["only"]);
  });
});
