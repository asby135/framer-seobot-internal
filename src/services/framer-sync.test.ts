import { describe, it, expect } from "vitest";
import {
  buildItems,
  wipeGuard,
  assertBoundCollection,
  findFramerLocaleId,
  buildLocaleMap,
  buildItem,
  FIELD_IDS,
  type CollectionItem,
} from "./framer-sync.js";

const RU = "mG5aB_oJw"; // the real locale id in CRMChat_New
const localeMap = new Map([["ru", RU]]);

const item = (fieldData: CollectionItem["fieldData"]): CollectionItem => ({
  id: "a1",
  slug: "my-slug",
  fieldData,
});

describe("findFramerLocaleId", () => {
  const locales = [
    { id: RU, code: "ru-RU", slug: "ru" },
    { id: "enId", code: "en-US", slug: "en" },
  ];

  it("matches a region-qualified code by prefix", () => {
    // The backend emits "ru"; Framer stores "ru-RU".
    expect(findFramerLocaleId("ru", locales)).toBe(RU);
  });

  it("matches on the locale slug", () => {
    expect(findFramerLocaleId("en", locales)).toBe("enId");
  });

  it("returns null for a locale the project does not have", () => {
    expect(findFramerLocaleId("fr", locales)).toBeNull();
  });

  it("does not match a different locale sharing a prefix fragment", () => {
    expect(findFramerLocaleId("r", locales)).toBeNull();
  });
});

describe("buildLocaleMap", () => {
  it("maps every backend locale it can resolve", () => {
    const map = buildLocaleMap(["ru"], [{ id: RU, code: "ru-RU", slug: "ru" }]);
    expect(map.get("ru")).toBe(RU);
  });

  it("omits locales with no Framer counterpart", () => {
    expect(buildLocaleMap(["fr"], [{ id: RU, code: "ru-RU", slug: "ru" }]).size).toBe(0);
  });
});

describe("buildItems", () => {
  it("remaps locale codes to Framer locale ids", () => {
    const [out] = buildItems(
      [item({ title: { type: "string", value: "EN", valueByLocale: { ru: { action: "set", value: "RU" } } } })],
      localeMap
    );
    expect(out.fieldData.title.valueByLocale).toEqual({ [RU]: { action: "set", value: "RU" } });
  });

  it("drops valueByLocale entirely when nothing maps", () => {
    const [out] = buildItems(
      [item({ title: { type: "string", value: "EN", valueByLocale: { fr: { action: "set", value: "FR" } } } })],
      localeMap
    );
    expect(out.fieldData.title).not.toHaveProperty("valueByLocale");
    expect(out.fieldData.title.value).toBe("EN");
  });

  it("passes through fields that have no locale data", () => {
    const [out] = buildItems([item({ category: { type: "string", value: "crm" } })], localeMap);
    expect(out.fieldData.category).toEqual({ type: "string", value: "crm" });
  });

  it("preserves item id and slug — identity must never change", () => {
    // A changed id orphans the Framer item; a changed slug breaks the live URL.
    const [out] = buildItems([item({})], localeMap);
    expect(out).toMatchObject({ id: "a1", slug: "my-slug" });
  });

  it("can strip locales entirely for the no-locale fallback path", () => {
    const [out] = buildItems(
      [item({ title: { type: "string", value: "EN", valueByLocale: { ru: { action: "set", value: "RU" } } } })],
      localeMap,
      { includeLocales: false }
    );
    expect(out.fieldData.title).not.toHaveProperty("valueByLocale");
  });

  it("does not mutate the input items", () => {
    const input = [item({ title: { type: "string", value: "EN", valueByLocale: { ru: { action: "set", value: "RU" } } } })];
    buildItems(input, localeMap);
    expect(input[0].fieldData.title.valueByLocale).toEqual({ ru: { action: "set", value: "RU" } });
  });
});

describe("wipeGuard", () => {
  // Signature: (backendCount, framerCount, removalCount, maxRemovalShare).
  // removalCount MUST be the actual stale set — see syncCollection.

  it("blocks when the backend is empty but Framer holds items", () => {
    // The exact shape of a lost database: sync would delete the whole blog.
    const r = wipeGuard(0, 308, 308, 0.2);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/0 published/i);
  });

  it("blocks when removals exceed the allowed share", () => {
    const r = wipeGuard(200, 308, 108, 0.2); // 108 of 308 = 35%
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/remove/i);
  });

  it("blocks a full-corpus removal even when the counts match", () => {
    // IDs diverged; counts are identical. The count-based guard passed this.
    expect(wipeGuard(308, 308, 308, 0.2).ok).toBe(false);
  });

  it("allows a normal incremental sync that adds items", () => {
    expect(wipeGuard(310, 308, 0, 0.2).ok).toBe(true);
  });

  it("allows a small removal within the share", () => {
    expect(wipeGuard(300, 308, 8, 0.2).ok).toBe(true); // 2.6%
  });

  it("allows a handful of removals from a small collection", () => {
    // 1 of 3 is 33% by share, but deleting one article is an ordinary edit.
    expect(wipeGuard(2, 3, 1, 0.2).ok).toBe(true);
  });

  it("still blocks a large removal that is under the absolute floor's scale", () => {
    expect(wipeGuard(50, 100, 40, 0.2).ok).toBe(false);
  });

  it("allows the first sync into an empty collection", () => {
    expect(wipeGuard(308, 0, 0, 0.2).ok).toBe(true);
  });

  it("allows an empty backend when Framer is also empty", () => {
    expect(wipeGuard(0, 0, 0, 0.2).ok).toBe(true);
  });

  it("blocks a total wipe of a large collection at a permissive share", () => {
    expect(wipeGuard(0, 500, 500, 0.9).ok).toBe(false);
  });
});

describe("assertBoundCollection", () => {
  it("passes when the target is the configured bound collection", () => {
    expect(() => assertBoundCollection("kqBHLapEf", "kqBHLapEf")).not.toThrow();
  });

  it("throws when writing to a different collection", () => {
    // Framer resolves relative hrefs to CMS references at INGEST time. Writing
    // into an unbound collection silently strips every internal link, and the
    // Server API serializes stripped and intact links identically — so this
    // guard is the only thing that can catch it.
    expect(() => assertBoundCollection("otherId", "kqBHLapEf")).toThrow(/internal link/i);
  });

  it("names both ids so the alert is actionable", () => {
    expect(() => assertBoundCollection("otherId", "kqBHLapEf")).toThrow(/otherId.*kqBHLapEf|kqBHLapEf.*otherId/);
  });

  it("throws when no bound collection is configured", () => {
    expect(() => assertBoundCollection("kqBHLapEf", "")).toThrow();
  });
});

describe("buildItem", () => {
  const article = {
    id: "a1",
    slug: "my-slug",
    title: "EN Title",
    category: "crm",
    summary: "EN summary",
    content: "<p>EN body</p>",
    schema_jsonld: '{"@context":"https://schema.org","@type":"FAQPage"}',
    created_at: "2026-08-18 11:54:06",
    updated_at: "2026-08-19 11:56:43",
    image_url: "https://cdn.example/img.png",
  };
  const ru = {
    locale: "ru",
    title: "RU Title",
    summary: "RU summary",
    content: "<p>RU body</p>",
    schema_jsonld: '{"@context":"https://schema.org","@type":"FAQPage"}',
  };

  it("emits exactly the collection's field ids", () => {
    // An extra key is rejected by Framer; a missing one silently blanks that
    // field on every synced article.
    const keys = Object.keys(buildItem(article, []).fieldData).sort();
    expect(keys).toEqual([...FIELD_IDS].sort());
  });

  it("carries RU into every translatable field", () => {
    const fd = buildItem(article, [ru]).fieldData;
    expect(fd.title.valueByLocale?.ru.value).toBe("RU Title");
    expect(fd.summary.valueByLocale?.ru.value).toBe("RU summary");
    expect(fd.content.valueByLocale?.ru.value).toBe("<p>RU body</p>");
    expect(fd.schema_jsonld.valueByLocale?.ru.value).toContain("FAQPage");
  });

  it("leaves non-translatable fields without locale data", () => {
    const fd = buildItem(article, [ru]).fieldData;
    expect(fd.category).not.toHaveProperty("valueByLocale");
    expect(fd.created).not.toHaveProperty("valueByLocale");
    expect(fd.tool.value).toBe("crmchat-seo-engine");
  });

  it("drops unsafe JSON-LD rather than emitting it", () => {
    // Framer renders this verbatim inside a <script> tag.
    const bad = { ...article, schema_jsonld: "{not json" };
    expect(buildItem(bad, []).fieldData.schema_jsonld.value).toBe("");
  });

  it("omits a locale whose JSON-LD is unsafe but keeps its other fields", () => {
    const fd = buildItem(article, [{ ...ru, schema_jsonld: "{broken" }]).fieldData;
    expect(fd.schema_jsonld.valueByLocale).toEqual({});
    expect(fd.title.valueByLocale?.ru.value).toBe("RU Title");
  });

  it("tolerates null columns without emitting null into Framer", () => {
    const sparse = { ...article, summary: null, image_url: null, category: null };
    const fd = buildItem(sparse, []).fieldData;
    expect(fd.summary.value).toBe("");
    expect(fd.image.value).toBe("");
    expect(fd.category.value).toBe("");
  });

  it("preserves the article id and slug verbatim", () => {
    const out = buildItem(article, []);
    expect(out.id).toBe("a1");
    expect(out.slug).toBe("my-slug");
  });
});
