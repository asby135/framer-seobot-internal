import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one-off clean-up of links to other companies' sites, across English
 * articles and their translations, without spending a re-translation.
 */

let getDb: typeof import("../db/index.js").getDb;
let articles: typeof import("./articles.js").articles;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-strip-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ articles } = await import("./articles.js"));
});

const EN =
  '<p>Per <a href="https://onlymonster.ai/faq">its FAQ</a>, see <a href="/blog/x">chatters</a> and <a href="https://core.telegram.org/bots/api">the Bot API</a>.</p>';
const RU = '<p>По <a href="https://onlymonster.ai/faq">их FAQ</a>, см. <a href="/blog/x">чаттеры</a>.</p>';

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM article_translations").run();
  db.prepare("DELETE FROM articles").run();
  db.prepare("INSERT INTO articles (id, title, slug, content, status) VALUES ('a1', 'T', 't', ?, 'published')").run(EN);
  db.prepare("INSERT INTO article_translations (id, article_id, locale, title, content) VALUES ('t1', 'a1', 'ru', 'Т', ?)").run(RU);
});

const run = (q = "") => articles.request(`/strip-external-links${q}`, { method: "POST" });
const content = () => (getDb().prepare("SELECT content FROM articles WHERE id = 'a1'").get() as { content: string }).content;
const ru = () => (getDb().prepare("SELECT content FROM article_translations WHERE id = 't1'").get() as { content: string }).content;

describe("POST /strip-external-links", () => {
  it("reports without writing on a dry run", async () => {
    const body = (await (await run("?dry_run=1")).json()) as { articles_changed: number; translations_changed: number; links_by_host: Record<string, number> };
    expect(body).toMatchObject({ articles_changed: 1, translations_changed: 1, links_by_host: { "onlymonster.ai": 1 } });
    expect(content()).toBe(EN);
  });

  it("unwraps vendor links in both languages and keeps internal and Telegram links", async () => {
    await run();
    expect(content()).toBe(
      '<p>Per its FAQ, see <a href="/blog/x">chatters</a> and <a href="https://core.telegram.org/bots/api">the Bot API</a>.</p>'
    );
    expect(ru()).toBe('<p>По их FAQ, см. <a href="/blog/x">чаттеры</a>.</p>');
  });

  it("changes nothing the second time", async () => {
    await run();
    const body = (await (await run()).json()) as { articles_changed: number; translations_changed: number };
    expect(body).toMatchObject({ articles_changed: 0, translations_changed: 0 });
  });
});
