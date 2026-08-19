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

export interface SchemaField {
  id: string;
  name: string;
  type: string;
}

/**
 * Removals at or below this count are always allowed, regardless of share.
 * Deleting a handful of articles is a normal edit; the guard is aimed at the
 * case where a lost or rebuilt database would take the whole corpus with it.
 */
const MIN_UNGUARDED_REMOVALS = 10;

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
  removalCount: number,
  maxRemovalShare: number
): GuardResult {
  if (framerCount === 0) return { ok: true };

  if (backendCount === 0) {
    return {
      ok: false,
      reason: `backend reports 0 published articles while Framer holds ${framerCount} — refusing to sync`,
    };
  }

  // An absolute floor below the share check. The share alone makes any removal
  // from a small collection look catastrophic — 1 of 3 is 33% — which would
  // block ordinary edits while a collection is still growing. The guard exists
  // to catch mass deletion, not to forbid deletion.
  if (removalCount <= MIN_UNGUARDED_REMOVALS) return { ok: true };

  // MUST be the actual removal set, not framerCount - backendCount. Those
  // differ whenever IDs diverge rather than counts: 308 backend rows whose ids
  // no longer match Framer's 308 items yields 0 by subtraction and 308 by set
  // difference. The count-based version passed that case and deleted the lot.
  if (removalCount / framerCount > maxRemovalShare) {
    return {
      ok: false,
      reason: `sync would remove ${removalCount} of ${framerCount} items (over ${Math.round(
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

/**
 * The bound collection's field definitions, as verified against the live
 * project. Used to reconcile fields on sync — previously read from a setting
 * that nothing ever wrote, which made the whole reconciliation block dead code.
 */
export const FRAMER_FIELDS: SchemaField[] = [
  { id: "image", name: "Image", type: "image" },
  { id: "title", name: "Title", type: "string" },
  { id: "category", name: "Category", type: "string" },
  { id: "created", name: "Created", type: "date" },
  { id: "updated", name: "Updated", type: "date" },
  { id: "summary", name: "Summary", type: "string" },
  { id: "content", name: "Content", type: "formattedText" },
  { id: "schema_jsonld", name: "Schema JSON-LD", type: "string" },
  { id: "tool", name: "Tool", type: "string" },
];

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
 * The subset of Framer's ManagedCollection this module needs.
 *
 * Exists so the destructive path can be driven by a fake in tests. The guards
 * are only meaningful in relation to the calls around them, and asserting them
 * as standalone predicates is what let a wrong-quantity guard ship.
 */
export interface CollectionPort {
  id: string;
  getItemIds(): Promise<string[]>;
  getFields(): Promise<SchemaField[]>;
  setFields(fields: SchemaField[]): Promise<void>;
  addItems(items: CollectionItem[]): Promise<void>;
  removeItems(ids: string[]): Promise<void>;
  setPluginData(key: string, value: string): Promise<void>;
}

export interface SyncOptions {
  collectionId: string;
  maxRemovalShare: number;
  fields: SchemaField[];
}

/** Errors that indicate a locale/variable problem rather than a transport failure. */
function isLocaleFailure(e: unknown): boolean {
  const message = e instanceof Error ? e.message.toLowerCase() : "";
  return (
    message.includes("locale") ||
    message.includes("variable") ||
    message.includes("valuebylocale")
  );
}

/**
 * Orchestrate a sync against an already-connected collection.
 *
 * Order is load-bearing:
 *   1. assert the target is the configured collection
 *   2. compute the stale set
 *   3. guard on that set's size          <- before anything destructive
 *   4. remove stale, then add            <- remove first: a regenerated article
 *                                           reuses its slug with a new id, and
 *                                           Framer rejects duplicate slugs
 */
export async function syncCollection(
  collection: CollectionPort,
  payload: CollectionItem[],
  locales: string[],
  framerLocales: FramerLocale[],
  opts: SyncOptions
): Promise<SyncResult> {
  assertBoundCollection(collection.id, opts.collectionId);

  const existingIds = await collection.getItemIds();
  const backendIds = new Set(payload.map((i) => i.id));
  const stale = existingIds.filter((id) => !backendIds.has(id));

  const guard = wipeGuard(payload.length, existingIds.length, stale.length, opts.maxRemovalShare);
  if (!guard.ok) throw new Error(guard.reason);

  // Fields are append-only: existing field objects go back with identical ids
  // so canvas variable bindings survive.
  if (opts.fields.length > 0) {
    const existingFields = await collection.getFields();
    const existing = new Set(existingFields.map((f) => f.id));
    const missing = opts.fields.filter((f) => !existing.has(f.id));
    if (existingFields.length === 0) await collection.setFields(opts.fields);
    else if (missing.length > 0) await collection.setFields([...existingFields, ...missing]);
  }

  const localeMap = buildLocaleMap(locales, framerLocales);
  if (localeMap.size === 0) {
    logger.warn({ locales }, "No Framer locale matched — syncing without translations");
  }

  if (stale.length > 0) await collection.removeItems(stale);

  const addAll = async (items: CollectionItem[]) => {
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      await collection.addItems(items.slice(i, i + CHUNK_SIZE));
    }
  };

  let withLocales = true;
  try {
    await addAll(buildItems(payload, localeMap));
  } catch (e) {
    // Only a locale-shaped failure justifies retrying without translations.
    // Catching everything meant a rate limit or network blip could silently
    // blank RU across the whole corpus with nothing but a log line.
    if (!isLocaleFailure(e)) throw e;

    logger.error(
      { error: e instanceof Error ? e.message : "unknown" },
      "Locale sync failed — retrying without translations"
    );
    withLocales = false;
    await addAll(buildItems(payload, localeMap, { includeLocales: false }));
  }

  await collection.setPluginData("lastSync", new Date().toISOString());

  logger.info({ synced: payload.length, removed: stale.length, withLocales }, "Framer sync complete");
  return { synced: payload.length, removed: stale.length, withLocales };
}

export interface SyncPreview {
  collectionId: string;
  backendCount: number;
  framerCount: number;
  staleCount: number;
  staleIds: string[];
  newCount: number;
  localeMapping: Record<string, string>;
  guard: GuardResult;
  wouldProceed: boolean;
}

/**
 * Report what a sync WOULD do, without writing anything.
 *
 * The point of this is the guard verdict. `syncToFramer` has real destructive
 * power over a live corpus, and the honest way to gain confidence in it is to
 * see its arithmetic on real data before granting it a write.
 */
export function previewSync(
  existingIds: string[],
  payload: CollectionItem[],
  locales: string[],
  framerLocales: FramerLocale[],
  opts: SyncOptions
): SyncPreview {
  const backendIds = new Set(payload.map((i) => i.id));
  const existing = new Set(existingIds);
  const stale = existingIds.filter((id) => !backendIds.has(id));
  const added = payload.filter((i) => !existing.has(i.id));
  const guard = wipeGuard(payload.length, existingIds.length, stale.length, opts.maxRemovalShare);

  return {
    collectionId: opts.collectionId,
    backendCount: payload.length,
    framerCount: existingIds.length,
    staleCount: stale.length,
    staleIds: stale.slice(0, 25), // enough to eyeball, not enough to flood
    newCount: added.length,
    localeMapping: Object.fromEntries(buildLocaleMap(locales, framerLocales)),
    guard,
    wouldProceed: guard.ok,
  };
}

/** Connect and report what a sync would do. Performs no writes. */
export async function previewSyncToFramer(): Promise<SyncPreview> {
  const collectionId = env.FRAMER_COLLECTION_ID || getSetting("framerCollectionId", "");
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
    const existingIds = await target.getItemIds();
    const framerLocales = (await framer.getLocales()) as unknown as FramerLocale[];

    return previewSync(existingIds, payload, locales, framerLocales, {
      collectionId,
      maxRemovalShare,
      fields: FRAMER_FIELDS,
    });
  } finally {
    await framer.disconnect();
  }
}

/**
 * Single-flight lock.
 *
 * Callbacks are handled concurrently (the webhook acknowledges before working),
 * and Telegram can redeliver an update. Two syncs interleaving removeItems and
 * addItems on one collection is exactly how a partial wipe happens, so a second
 * caller joins the run already in progress instead of starting another.
 */
let inFlight: Promise<SyncResult> | null = null;

/**
 * Connect to Framer and sync all published articles into the bound collection.
 * Does NOT publish the site — that is debounced separately.
 */
export async function syncToFramer(): Promise<SyncResult> {
  if (inFlight) {
    logger.info("Sync already in progress — joining it rather than starting a second");
    return inFlight;
  }
  inFlight = doSyncToFramer().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSyncToFramer(): Promise<SyncResult> {
  const collectionId = env.FRAMER_COLLECTION_ID || getSetting("framerCollectionId", "");
  const maxRemovalShare = getSetting("maxRemovalShare", 0.2);
  const fields = getSetting<SchemaField[]>("framerFields", FRAMER_FIELDS);

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

    const framerLocales = (await framer.getLocales()) as unknown as FramerLocale[];
    return await syncCollection(
      target as unknown as CollectionPort,
      payload,
      locales,
      framerLocales,
      { collectionId, maxRemovalShare, fields }
    );
  } finally {
    await framer.disconnect();
  }
}
