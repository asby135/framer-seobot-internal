import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for route shadowing.
 *
 * `GET /translate-status` was registered AFTER `GET /:id`. Hono matches in
 * registration order, so the literal path was swallowed by the parameter and
 * every call returned {"error":"Article not found"} — the plugin's translation
 * polling never worked, silently, for the life of the endpoint.
 */
beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-routing-")), "test.db");
  const { initDb } = await import("../db/index.js");
  initDb();
});

describe("articles route ordering", () => {
  it("GET /translate-status returns queue status, not 'Article not found'", async () => {
    const { articles } = await import("./articles.js");
    const res = await articles.request("/translate-status");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("queue");
    expect(body).not.toHaveProperty("error");
  });

  it("GET /:id still resolves for a genuine id", async () => {
    const { articles } = await import("./articles.js");
    const res = await articles.request("/some-unknown-id");

    // 404 with the not-found error is correct here — the id simply does not exist.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Article not found" });
  });
});
