import { connect } from "framer-api";
import { getDb } from "../db/index.js";
import { getSetting } from "./settings.js";
import { sanitizeJsonLd } from "../lib/jsonld.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * Framer CMS sync over the Server API.
 *
 * This is a port of the plugin's SyncHandler with two guards added, both of
 * which exist because of failures observed on the live project:
 *
 *   wipeGuard          — the sync removes "everything in Framer absent from the
 *                        backend", so an empty or half-loaded database deletes
 *                        the entire live blog in one call.
 *   assertBoundCollection — Framer resolves relative hrefs to CMS references at
 *                        INGEST time. Writing into a collection that is not
 *                        bound to the article page silently strips every
 *                        internal link, and the Server API serializes stripped
 *                        and intact links identically, so nothing downstream
 *                        can detect it.
 */

/** Items are written in batches; the full payload is ~10 MB. */
const CHUNK_SIZE = 20;

/** Locale code aliases, mirroring the plugin's LOCALE_CODE_MAP. */
const LOCALE_ALIASES: Record<string, string[]> = { ru: ["ru", "ru-RU"] };

export interface LocaleValue {
  action: string;
  value: string;
}

export interface FieldValue {
  type: string;
  value: string;
  valueByLocale?: Record<string, LocaleValue>;
}

export interface CollectionItem {
  id: string;
  slug: string;
  fieldData: Record<string, FieldValue>;
}

export interface FramerLocale {
  id: string;
  code: string;
  slug: string;
}

/**
 * Resolve a backend locale code to a Framer locale id.
 * The backend emits "ru"; the project stores "ru-RU" — hence the prefix match.
 */
export function findFramerLocaleId(
  localeCode: string,
  framerLocales: readonly FramerLocale[]
): string | null {
  const candidates = LOCALE_ALIASES[localeCode] ?? [localeCode];
  for (const candidate of candidates) {
    const match = framerLocales.find(
      (l) => l.code === candidate || l.slug === candidate || l.code.startsWith(candidate + "-")
    );
    if (match) return match.id;
  }
  return null;
}

export function buildLocaleMap(
  codes: readonly string[],
  framerLocales: readonly FramerLocale[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const code of codes) {
    const id = findFramerLocaleId(code, framerLocales);
    if (id) map.set(code, id);
  }
  return map;
}

/**
 * Rewrite backend items into Framer's input shape, remapping locale codes to
 * Framer locale ids. Item id and slug pass through untouched: the id is the
 * item's identity in Framer, and the slug is its live URL.
 */
export function buildItems(
  items: CollectionItem[],
  localeIdMap: Map<string, string>,
  opts: { includeLocales?: boolean } = {}
): CollectionItem[] {
  const includeLocales = opts.includeLocales !== false;

  return items.map((item) => {
    const fieldData: Record<string, FieldValue> = {};

    for (const [key, value] of Object.entries(item.fieldData)) {
      const { valueByLocale, ...rest } = value;

      if (!includeLocales || !valueByLocale) {
        fieldData[key] = { ...rest };
        continue;
      }

      const remapped: Record<string, LocaleValue> = {};
      for (const [code, entry] of Object.entries(valueByLocale)) {
        const id = localeIdMap.get(code);
        if (id) remapped[id] = entry;
      }

      fieldData[key] =
        Object.keys(remapped).length > 0 ? { ...rest, valueByLocale: remapped } : { ...rest };
    }

    return { id: item.id, slug: item.slug, fieldData };
  });
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Refuse to sync when the removal set looks like data loss rather than an edit.
 *
 * At 300+ articles an accidental wipe is unrecoverable without a restore, and
 * the failure is silent: the sync succeeds, the site republishes, and the blog
 * is simply gone.
 */
export function wipeGuard(
  backendCount: number,
  framerCount: number,
  maxRemovalShare: number
): GuardResult {
  if (framerCount === 0) return { ok: true };

  if (backendCount === 0) {
    return {
      ok: false,
      reason: `backend reports 0 published articles while Framer holds ${framerCount} — refusing to sync`,
    };
  }

  const removals = Math.max(0, framerCount - backendCount);
  if (removals / framerCount > maxRemovalShare) {
    return {
      ok: false,
      reason: `sync would remove ${removals} of ${framerCount} items (over ${Math.round(
        maxRemovalShare * 100
      )}%) — refusing`,
    };
  }

  return { ok: true };
}

/**
 * Refuse to write into a collection that is not the one bound to the article
 * CMS page.
 *
 * Observed 2026-08-19: items loaded into an unbound collection kept their <a>
 * elements but lost every internal link target, rendering as unstyled,
 * unclickable text. 1,065 links across 308 articles. Nothing in the API can
 * detect this after the fact, so it has to be prevented before the write.
 */
export function assertBoundCollection(targetId: string, configuredId: string): void {
  if (!configuredId) {
    throw new Error(
      "refusing to sync: no bound collection configured (FRAMER_COLLECTION_ID). " +
        "Syncing into an unbound collection destroys all internal links."
    );
  }
  if (targetId !== configuredId) {
    throw new Error(
      `refusing to sync: collection ${targetId} is not the configured bound collection ${configuredId}. ` +
        "Syncing into an unbound collection destroys all internal links."
    );
  }
}

interface SchemaField {
  id: string;
  name: string;
  type: string;
}

/** Read the published articles in Framer's item shape (mirrors /api/sync/collection). */
export function loadCollectionPayload(): { items: CollectionItem[]; locales: string[] } {
  const db = getDb();

  const articles = db
    .prepare(
      `SELECT a.id, a.title, a.slug, a.category, a.summary, a.content, a.schema_jsonld,
              a.created_at, a.updated_at,
              (SELECT url FROM assets WHERE article_id = a.id AND type = 'thumbnail' LIMIT 1) as image_url
       FROM articles a
       WHERE a.status = 'published'
       ORDER BY a.published_at DESC`
    )
    .all() as ArticleRow[];

  const translations = db
    .prepare(
      `SELECT t.article_id, t.locale, t.title, t.summary, t.content, t.schema_jsonld
       FROM article_translations t
       JOIN articles a ON a.id = t.article_id
       WHERE a.status = 'published'`
    )
    .all() as Array<TranslationRow & { article_id: string }>;

  const byArticle = new Map<string, typeof translations>();
  for (const t of translations) {
    const list = byArticle.get(t.article_id) ?? [];
    list.push(t);
    byArticle.set(t.article_id, list);
  }

  const items: CollectionItem[] = articles.map((a) => buildItem(a, byArticle.get(a.id) ?? []));

  return { items, locales: ["ru"] };
}

export interface ArticleRow {
  id: string;
  slug: string;
  title: string | null;
  category: string | null;
  summary: string | null;
  content: string | null;
  schema_jsonld: string | null;
  created_at: string | null;
  updated_at: string | null;
  image_url: string | null;
}

export interface TranslationRow {
  locale: string;
  title: string | null;
  summary: string | null;
  content: string | null;
  schema_jsonld: string | null;
}

/**
 * The field ids of the bound collection, as reported by the live project.
 * The payload must emit exactly these: an extra key is rejected by Framer, a
 * missing one silently blanks that field on every synced article.
 */
export const FIELD_IDS = [
  "title",
  "category",
  "summary",
  "content",
  "schema_jsonld",
  "created",
  "updated",
  "image",
  "tool",
] as const;

/** Build one Framer item from an article row and its translations. Pure. */
export function buildItem(a: ArticleRow, translations: TranslationRow[]): CollectionItem {
  const set = (value: string | null) => ({ action: "set", value: value ?? "" });
  const byLocale = (pick: (t: TranslationRow) => string | null) =>
    Object.fromEntries(translations.map((t) => [t.locale, set(pick(t))]));

  // JSON-LD is re-sanitized at the egress point as defence in depth: Framer
  // renders it verbatim inside a <script> tag, and a legacy or hand-edited row
  // could carry something the generator would not produce today.
  const schemaByLocale: Record<string, LocaleValue> = {};
  for (const t of translations) {
    const safe = t.schema_jsonld ? sanitizeJsonLd(t.schema_jsonld) : "";
    if (safe) schemaByLocale[t.locale] = { action: "set", value: safe };
  }

  return {
    id: a.id,
    slug: a.slug,
    fieldData: {
      title: { type: "string", value: a.title ?? "", valueByLocale: byLocale((t) => t.title) },
      category: { type: "string", value: a.category ?? "" },
      summary: { type: "string", value: a.summary ?? "", valueByLocale: byLocale((t) => t.summary) },
      content: {
        type: "formattedText",
        value: a.content ?? "",
        valueByLocale: byLocale((t) => t.content),
      },
      schema_jsonld: {
        type: "string",
        value: sanitizeJsonLd(a.schema_jsonld ?? "") || "",
        valueByLocale: schemaByLocale,
      },
      created: { type: "date", value: a.created_at ?? "" },
      updated: { type: "date", value: a.updated_at ?? "" },
      image: { type: "image", value: a.image_url ?? "" },
      tool: { type: "string", value: "crmchat-seo-engine" },
    },
  };
}

export interface SyncResult {
  synced: number;
  removed: number;
  withLocales: boolean;
}

/**
 * Push all published articles into the bound Framer collection.
 * Does NOT publish the site — that is debounced separately.
 */
export async function syncToFramer(): Promise<SyncResult> {
  const collectionId = getSetting("framerCollectionId", env.FRAMER_COLLECTION_ID);
  const maxRemovalShare = getSetting("maxRemovalShare", 0.2);

  const { items: payload, locales } = loadCollectionPayload();

  const framer = await connect(env.FRAMER_PROJECT_URL, env.FRAMER_API_KEY);
  try {
    const collections = await framer.getManagedCollections();
    const target = collections.find((c) => c.id === collectionId);
    if (!target) {
      throw new Error(
        `configured collection ${collectionId} not found among ${collections.length} managed collections`
      );
    }
    assertBoundCollection(target.id, collectionId);

    const existingIds = await target.getItemIds();
    const guard = wipeGuard(payload.length, existingIds.length, maxRemovalShare);
    if (!guard.ok) throw new Error(guard.reason);

    // Fields are append-only: existing field objects go back with identical ids
    // so canvas variable bindings survive.
    const existingFields = (await target.getFields()) as SchemaField[];
    const backendFields = getSetting<SchemaField[]>("framerFields", []);
    if (backendFields.length > 0) {
      const existing = new Set(existingFields.map((f) => f.id));
      const missing = backendFields.filter((f) => !existing.has(f.id));
      if (existingFields.length === 0) await target.setFields(backendFields as never);
      else if (missing.length > 0) await target.setFields([...existingFields, ...missing] as never);
    }

    const localeMap = buildLocaleMap(locales, await framer.getLocales());
    if (localeMap.size === 0) {
      logger.warn({ locales }, "No Framer locale matched — syncing without translations");
    }

    const backendIds = new Set(payload.map((i) => i.id));
    const stale = existingIds.filter((id) => !backendIds.has(id));

    // Remove before adding: a regenerated article keeps its slug but takes a new
    // id, and Framer rejects duplicate slugs.
    if (stale.length > 0) await target.removeItems(stale);

    let withLocales = true;
    const items = buildItems(payload, localeMap);
    try {
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        await target.addItems(items.slice(i, i + CHUNK_SIZE) as never);
      }
    } catch (e) {
      // Orphaned variable references in the project can make locale writes fail.
      // Fall back to syncing content without translations rather than blocking.
      logger.warn(
        { error: e instanceof Error ? e.message : "unknown" },
        "Locale sync failed — retrying without translations"
      );
      withLocales = false;
      const plain = buildItems(payload, localeMap, { includeLocales: false });
      for (let i = 0; i < plain.length; i += CHUNK_SIZE) {
        await target.addItems(plain.slice(i, i + CHUNK_SIZE) as never);
      }
    }

    await target.setPluginData("lastSync", new Date().toISOString());

    logger.info(
      { synced: items.length, removed: stale.length, withLocales },
      "Framer sync complete"
    );
    return { synced: items.length, removed: stale.length, withLocales };
  } finally {
    await framer.disconnect();
  }
}
