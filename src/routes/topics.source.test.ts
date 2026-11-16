import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Serpstat-sourced topics: the operator asked to see, in the Telegram digests,
 * which articles came from the competitor research. That needs the source to
 * survive every way a topic gets in (import, custom, re-tag), to stay
 * selectable, and to show up as "(Serpstat)" at both gates.
 */

let getDb: typeof import("../db/index.js").getDb;
let topics: typeof import("./topics.js").topics;
let research: typeof import("./research.js").research;
let insertSeededTopics: typeof import("../services/seeder.js").insertSeededTopics;
let usableTopics: typeof import("../services/selection.js").usableTopics;
let digestItems: typeof import("../services/bootstrap.js").digestItems;
let sourceTag: typeof import("../lib/topic-source.js").sourceTag;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "seo-source-")), "test.db");
  process.env.ANTHROPIC_API_KEY ??= "test";
  const dbMod = await import("../db/index.js");
  dbMod.initDb();
  getDb = dbMod.getDb;
  ({ topics } = await import("./topics.js"));
  ({ research } = await import("./research.js"));
  ({ insertSeededTopics } = await import("../services/seeder.js"));
  ({ usableTopics } = await import("../services/selection.js"));
  ({ digestItems } = await import("../services/bootstrap.js"));
  ({ sourceTag } = await import("../lib/topic-source.js"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM articles").run();
  getDb().prepare("DELETE FROM keywords").run();
});

const post = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const sourceOf = (query: string) =>
  (getDb().prepare("SELECT source FROM keywords WHERE query = ?").get(query) as { source: string } | undefined)?.source;

describe("sourceTag", () => {
  it("tags Serpstat topics and nothing else", () => {
    expect(sourceTag("serpstat")).toBe(" (Serpstat)");
    expect(sourceTag("seeded")).toBe("");
    expect(sourceTag(null)).toBe("");
  });
});

describe("digestItems", () => {
  it("puts (Serpstat) after a Serpstat title", () => {
    expect(
      digestItems([{ keywordId: "k", query: "What Is Telegram OFM", title: "What Is Telegram OFM", source: "serpstat" }])
    ).toEqual([{ label: "What Is Telegram OFM (Serpstat)" }]);
  });

  it("leaves other titles as they were", () => {
    expect(digestItems([{ keywordId: "k", query: "How to Tag Leads", title: "How to Tag Leads", source: "seeded" }])).toEqual([
      { label: "How to Tag Leads" },
    ]);
  });
});

describe("selection", () => {
  it("can pick Serpstat topics", () => {
    // Selection is an allowlist; a source missing from it never gets written.
    expect(usableTopics([{ id: "1", query: "q", source: "serpstat" }])).toHaveLength(1);
  });
});

describe("insertSeededTopics with a source", () => {
  it("stores the named source", () => {
    insertSeededTopics(["How to Price a Paid Telegram VIP Channel"], undefined, { source: "serpstat" });
    expect(sourceOf("How to Price a Paid Telegram VIP Channel")).toBe("serpstat");
  });

  it("defaults to seeded", () => {
    insertSeededTopics(["How to Price a Paid Telegram VIP Channel"]);
    expect(sourceOf("How to Price a Paid Telegram VIP Channel")).toBe("seeded");
  });
});

describe("POST /api/research/seed with a source", () => {
  it("imports as Serpstat topics", async () => {
    const res = await post(research, "/seed", { topics: ["What Is Telegram OFM"], source: "serpstat" });
    expect(res.status).toBe(200);
    expect(sourceOf("What Is Telegram OFM")).toBe("serpstat");
  });

  it("refuses a source selection cannot use", async () => {
    const res = await post(research, "/seed", { topics: ["What Is Telegram OFM"], source: "era" });
    expect(res.status).toBe(400);
    expect(sourceOf("What Is Telegram OFM")).toBeUndefined();
  });
});

describe("POST /custom with a source", () => {
  it("adds an approved Serpstat topic", async () => {
    const res = await post(topics, "/custom", { query: "Infloww Alternatives for OnlyFans Agencies", source: "serpstat" });
    expect(res.status).toBe(201);
    expect(sourceOf("Infloww Alternatives for OnlyFans Agencies")).toBe("serpstat");
  });

  it("refuses an unknown source", async () => {
    const res = await post(topics, "/custom", { query: "Infloww Alternatives for OnlyFans Agencies", source: "era-gap" });
    expect(res.status).toBe(400);
  });
});

describe("gate 2 (Ready for review)", () => {
  it("tags an article written from a Serpstat topic", async () => {
    const { __setTransport } = await import("../services/notify.js");
    const { sendArticleReadyDigest } = await import("../services/bootstrap.js");
    const texts: string[] = [];
    const fetchSpy = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}")) as { text?: string };
      if (body.text) texts.push(body.text);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    __setTransport({ fetch: fetchSpy as never, token: "T", chatId: "1" });
    try {
      getDb().prepare("INSERT INTO keywords (id, query, status, source) VALUES ('k1', 'What Is Telegram OFM', 'generated', 'serpstat')").run();
      getDb()
        .prepare("INSERT INTO articles (id, keyword_id, title, slug, status) VALUES ('a1', 'k1', 'What Is Telegram OFM', 'what-is-telegram-ofm', 'review')")
        .run();
      await sendArticleReadyDigest("a1");
      expect(texts[0]).toContain("<b>What Is Telegram OFM</b> (Serpstat)");
    } finally {
      __setTransport(null);
    }
  });
});

describe("POST /source", () => {
  const add = (id: string, query: string, status: string, source = "seeded") =>
    getDb().prepare("INSERT INTO keywords (id, query, status, source) VALUES (?, ?, ?, ?)").run(id, query, status, source);

  it("re-tags pending and approved topics by exact text, case-insensitively", async () => {
    add("a", "What Is Telegram OFM", "pending");
    add("b", "Infloww Alternatives for OnlyFans Agencies", "approved", "custom");
    const res = await post(topics, "/source", {
      source: "serpstat",
      queries: ["what is telegram ofm", "Infloww Alternatives for OnlyFans Agencies", "Not In The Queue"],
    });
    expect(await res.json()).toEqual({ updated: 2, unmatched: ["Not In The Queue"] });
    expect(sourceOf("What Is Telegram OFM")).toBe("serpstat");
    expect(sourceOf("Infloww Alternatives for OnlyFans Agencies")).toBe("serpstat");
  });

  it("leaves written and rejected topics alone", async () => {
    add("g", "How to Tag Leads", "generated");
    add("r", "How to Export Leads", "rejected");
    const res = await post(topics, "/source", { source: "serpstat", queries: ["How to Tag Leads", "How to Export Leads"] });
    expect(((await res.json()) as { updated: number }).updated).toBe(0);
    expect(sourceOf("How to Tag Leads")).toBe("seeded");
  });

  it("refuses an unknown source", async () => {
    const res = await post(topics, "/source", { source: "era", queries: ["x"] });
    expect(res.status).toBe(400);
  });
});
