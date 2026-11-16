import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Russian creator-agency articles say «модель», not «креатор». The first batch
 * of creator-agency articles came out with «креатор» up to 17 times each,
 * because nothing told the translator otherwise.
 */

const calls: Array<{ system: string }> = [];
vi.mock("../lib/claude.js", async (orig) => ({
  ...(await orig<typeof import("../lib/claude.js")>()),
  callJson: async (_client: unknown, opts: { system: string }) => {
    calls.push({ system: opts.system });
    return { title: "Т", slug: "t", summary: "", content: "<p>т</p>", schema_jsonld: "" };
  },
}));

let getDb: typeof import("../db/index.js").getDb;
let translateArticle: typeof import("./translator.js").translateArticle;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-translator-terms-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ translateArticle } = await import("./translator.js"));
});

describe("Russian translation rules", () => {
  it("tells the translator to write «модель», never «креатор»", async () => {
    getDb()
      .prepare("INSERT INTO articles (id, title, slug, summary, content, status) VALUES ('a1', 'What Is Telegram OFM', 'ofm', '', '<p>creators</p>', 'review')")
      .run();
    await translateArticle("a1");
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("«модель»");
    expect(calls[0].system).toContain("never «креатор»");
  });
});
