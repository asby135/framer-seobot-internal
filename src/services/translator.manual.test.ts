import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A hand-written translation survives re-translation. An edit to the English
 * text forces one, and before the manual flag it replaced a Russian version
 * that quoted the Russian app word for word with a translation of the English
 * quotes.
 */

const callJson = vi.fn(async () => ({
  title: "Переведено",
  slug: "perevedeno",
  summary: "",
  content: "<p>перевод</p>",
  schema_jsonld: "",
}));
vi.mock("../lib/claude.js", async (orig) => ({
  ...(await orig<typeof import("../lib/claude.js")>()),
  callJson: () => callJson(),
}));

let getDb: typeof import("../db/index.js").getDb;
let translateArticle: typeof import("./translator.js").translateArticle;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-translator-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ translateArticle } = await import("./translator.js"));
});

beforeEach(() => {
  callJson.mockClear();
  const db = getDb();
  db.prepare("DELETE FROM article_translations").run();
  db.prepare("DELETE FROM articles").run();
  db.prepare("DELETE FROM keywords").run();
  db.prepare("INSERT INTO keywords (id, query, status) VALUES ('k1', 'q', 'generated')").run();
  db.prepare("INSERT INTO articles (id, keyword_id, title, slug, content, status) VALUES ('a', 'k1', 'T', 's', '<p>en</p>', 'published')").run();
});

const ru = () =>
  (getDb().prepare("SELECT content FROM article_translations WHERE article_id = 'a' AND locale = 'ru'").get() as { content: string })
    .content;
const addRu = (manual: number) =>
  getDb()
    .prepare("INSERT INTO article_translations (id, article_id, locale, title, content, manual) VALUES ('t', 'a', 'ru', 'Т', '<p>вручную</p>', ?)")
    .run(manual);

describe("translateArticle", () => {
  it("keeps a hand-written translation, even when forced", async () => {
    addRu(1);
    const result = await translateArticle("a", true);
    expect(result.skipped).toEqual(["ru"]);
    expect(callJson).not.toHaveBeenCalled();
    expect(ru()).toBe("<p>вручную</p>");
  });

  it("still replaces a machine translation when forced", async () => {
    addRu(0);
    const result = await translateArticle("a", true);
    expect(result.translated).toEqual(["ru"]);
    expect(ru()).toBe("<p>перевод</p>");
  });
});
