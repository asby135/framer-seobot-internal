# SEO Autopilot — Design

**Date:** 2026-08-18
**Status:** Design agreed, not yet implemented

Automate topic seeding, title proposal, article generation, RU translation, Framer
sync and site publishing, behind two Telegram approval gates. Replaces the manual
loop of seeding audiences by hand, approving topics in the plugin, triggering
generation, triggering translation, and pressing Sync in Framer.

## Goal

Run 5-10 articles per night unattended, with two taps from the operator: approve
the proposed titles, then approve the finished articles. Framer never needs to be
opened for the daily loop.

## Key platform finding

Framer shipped a **Server API** (Feb 2026, `framer-api` on npm, free open beta).
It exposes the same surface as the Plugin API *plus* publishing, from any server:

- `framer.getManagedCollections()` — managed collections, the kind `seobtn` owns
- `collection.setFields() / addItems() / removeItems() / setItemOrder()`
- `framer.getLocales()`, and field inputs accept
  `valueByLocale: { [localeId]: { action: "set", value } }`
- `framer.publish()` then `framer.deploy(deploymentId)`

The per-locale shape is byte-identical to what `src/routes/sync.ts` already emits,
so RU translations carry across with no reshaping.

Caveats from Framer's own docs: not transactional, ~1-2s cold start, JS SDK only,
free during beta with usage-based pricing expected later.

`framer-api` requires **Node >= 22**; the Dockerfile currently pins `node:20-slim`.

## Spike result (2026-08-18) — collection ownership

Read-only spike against project `CRMChat-New--obDYpxrpLqjA1CG4lfvg`:

```
"CRMChat SEO Engine" (cPhSKcDSv)  managedBy = anotherPlugin   readonly = true
"Seobot"             (hNojT21es)  managedBy = anotherPlugin   readonly = true
"articles"           (ewhHuyXZI)  managedBy = user            readonly = false
getManagedCollections() → 0
LOCALES → ru-RU (mG5aB_oJw)
```

**The Server API cannot write the existing collection.** It is owned by the
`seobtn` plugin, and `createManagedCollection(name)` accepts only a name — there
is no adoption parameter, and it rejects names that match an existing collection.
Per the type docs: "Collections managed by plugins are read-only. To modify them,
use `ManagedCollection` (only possible in `configureManagedCollection` or
`syncManagedCollection` modes)."

Two findings that make migration cheap:

- The collection's 9 field IDs already match the backend schema exactly:
  `image, title, category, created, updated, summary, content, tool, schema_jsonld`
- Locale is `ru-RU` / `mG5aB_oJw`; `findFramerLocaleId()` already resolves `"ru"`
  through its `startsWith("ru-")` branch, so the mapping ports unchanged.

**Decision: migrate to a Server-API-owned managed collection.**

### Migration procedure

1. ~~`createManagedCollection("CRMChat SEO Engine (API)")`~~ **DONE 2026-08-19** —
   id `kqBHLapEf`.
2. ~~`setFields()` with the 9 field IDs from `/api/schema`~~ **DONE** — 9 fields.
3. ~~`addItems()` from `/api/sync/collection`~~ **DONE** — 308 items in chunks of 20
   (payload is ~10 MB, so a single call is not advisable).
4. ~~Verify~~ **DONE** — 308/308 items, slug parity exact (0 missing), RU present on
   title, summary, content and schema_jsonld. Ownership confirmed:

   ```
   "CRMChat SEO Engine"        managedBy=anotherPlugin   items=308
   "CRMChat SEO Engine (API)"  managedBy=thisPlugin      items=308
   ```

   Remaining steps are manual, in the Framer editor:

5. In Framer, repoint the blog listing and the article CMS page to the new
   collection and rebind the template fields.
5a. **RE-SYNC AFTER REPOINTING — required.** Framer resolves relative hrefs
   (`<a href="/blog/slug">`) to CMS item references *at ingest time*, against the
   site's route map. Items loaded into a collection that is not yet bound to a
   CMS page keep the `<a>` element but lose the link target: the anchor renders
   unstyled (invisible on dark backgrounds) and is not clickable. Confirmed
   2026-08-19 — identical article renders blue links in the old collection and
   dead ones in the API collection. Absolute URLs are unaffected, since they
   need no resolution. The API serializes resolved and unresolved links
   identically (bare `<a>`), so this is NOT detectable via the Server API —
   only by eye on the canvas. Re-run `addItems` (an upsert on item ID) once the
   page is bound. **Verified fixed 2026-08-19:** page repointed, all 308 items
   re-synced, internal links render correctly again.
6. Preview, then publish once, so there is no window where `/blog/*` 404s.
7. Rename old → "CRMChat SEO Engine (legacy)", new → "CRMChat SEO Engine".
8. Keep the legacy collection for rollback; delete only after a few days live.

**Slugs are preserved, so URLs do not change.** The unverified part is step 5 —
whether Framer allows changing a CMS page's source collection in place, or whether
the page must be recreated against the new collection. Confirm in the editor
before deleting anything.

**Consequence for the fallback story:** after migration the plugin's `SyncHandler`
writes to the legacy collection, which nothing renders. The plugin becomes
settings/deep-dive only, and the real fallback is re-running the backend sync.

## Decisions

| Decision | Choice |
|---|---|
| Automation level | Autopilot with review gates |
| Gates | Two: proposed titles, then finished articles |
| Review surface | Telegram bot; plugin becomes settings/deep-dive only |
| Gate 1 content | Proposed headline from a new `proposeTitle()` step |
| Gate 2 preview | Message summary + full article attached as `.html` |
| Batching | One digest per gate, per-item buttons plus Approve all / Reject all |
| Volume | 5-10 articles per night, randomised |
| Topic source | Self-seeded audiences (Era research dropped — it didn't work) |
| Taxonomy | niche → subniche → angle |
| Subniches | Claude proposes ~6 per niche, editable in Settings |
| Angles | how-to, comparison, migration, troubleshooting, pricing |
| Thin-KB niches | Start them, watch output, write KB pages if weak |
| RU niches | English-first; existing translator serves `/ru/` |
| Publish timing | Debounced — one site deploy ~5 min after last approval |
| Scheduler | In-process (Railway cron requires process exit; volume is single-mount) |
| Plugin hosting | Static build on a public URL, opened via "Open Plugin from URL" |

## Audiences

Eight niches. The first five have industry pages and case studies in `knowledge/`;
the last three have thin or no KB coverage and start on **probation**.

| Niche | KB grounding |
|---|---|
| Web3 / crypto | `industry-web3-crypto.md`, `product-web3-database.md` |
| B2B lead-gen agencies | `industry-leadgen-agencies.md`, LeadSniper/uForce/LeadBridge cases |
| iGaming affiliates | `industry-igaming.md` |
| Creator / OnlyFans agencies | `creator-agency-telegram.md`, `product-ppv-bot.md` |
| Media buying | `industry-media-buying.md` |
| RU B2B SaaS | thin — `finding-decision-makers-ru-cis.md` only (probation) |
| RU AI companies | none (probation) |
| Online currency exchanges | none (probation) |

Each niche stores a **persona sentence**, not a label — `seedTopics()` grounds on
`searchKB(audience, 5)`, so lexical overlap with the industry page matters.
Optional `kb_hints` force-include specific KB docs ahead of TF-IDF.

**Probation:** topics from a probationary niche land as `pending` and appear in the
digest, but are excluded from auto-pick until manually approved in the Topics tab.
Clear the flag once the niche proves out.

## Architecture

One Railway service, unchanged in kind. New pieces:

- `src/services/scheduler.ts` — nightly run, single-flight lock, `last_run_date`
- `src/services/framer-sync.ts` — Server API push, publish/deploy, wipe guard
- `src/services/notify.ts` — Telegram digests and alerts
- `src/routes/telegram.ts` — webhook, `secret_token`, chat-ID allowlist
- `settings` table — key/value JSON: niches, rotation cursor, schedule, Framer creds
  (`FRAMER_COLLECTION_ID=kqBHLapEf`, locale `ru` → `mG5aB_oJw`)
- `keywords` gains `proposed_title`, `bot_message_id`
- Dockerfile: `node:20-slim` → `node:22-slim`

The plugin keeps `getPluginData` for credentials and retains `SyncHandler` as a
manual fallback. It is no longer on the daily critical path.

## Nightly flow

**~20:00 — propose**

1. **Top-up.** Count pending `source='seeded'` keywords. If low, advance the
   rotation cursor to the next `(niche, subniche, angle)` and call `seedTopics()`
   with `persona + subniche` as the audience and the angle as a hard constraint.
2. **Select.** Randomly pick 5-10 pending topics from non-probationary niches.
   Selection filters to `source IN ('seeded', 'custom')` — Era/GSC rows are
   excluded permanently, not just deprioritised.
3. **Title.** `proposeTitle()` per topic — reuses the TITLE CRAFT rules and
   `findTitleTics()` ban-list, plus recent published titles for shape variety.
4. **Gate 1 digest.** Numbered list of proposed headlines with niche → subniche →
   angle and the underlying topic phrase. Buttons per item plus Approve all /
   Reject all. Reroll re-invokes `proposeTitle()` excluding the rejected headline.

**Overnight — generate**

5. Approval pins the title to the keyword and enqueues generation with a
   `titleOverride`, passed into the `publish_article` tool as required output so
   the body is written to the approved headline.
6. Completion auto-enqueues RU translation — the chain `queue.ts` doesn't do today.
7. Articles land in `review`. Nothing publishes unattended.

**Morning — publish**

8. **Gate 2 digest.** EN title, RU title, summary, word count, flags
   (`thumbnail_missing`, `low_kb_match`, `ru_missing`), full article attached as
   `.html`. Buttons: Publish / Regenerate / Delete, plus Publish all.
9. Publish calls the existing `POST /api/articles/:id/publish`, pushes the item to
   Framer, and arms a 5-minute debounce.
10. Debounce fires once: `framer.publish()` → `framer.deploy()` → `sync_log` →
    Telegram confirmation.

## Anti-repetition

Three mechanisms, all needed at this volume:

1. **Taxonomy depth.** 8 niches × ~6 subniches × 5 angles = 240 rotation slots.
   At 10 topics per seed that is ~2,400 topics, roughly a year at 7.5/night.
   (Without the angle level: 480 topics, ~64 nights.)
2. **Already-covered block.** `generateTopicCandidates()` gains a fourth input —
   the last ~60 topic queries and ~30 published titles, injected as "propose
   adjacent territory, not variations of these." This is the change that makes
   long-run rotation viable; the taxonomy alone only delays repetition.
3. **Wider title-variety window.** The generator's last-30-published-titles check
   covers a month at 2-3/night but only ~4 days at 7.5/night. Widen to 100.

## Safety rails

- **Wipe guard.** `SyncHandler` computes `toRemove` as "Framer items absent from
  the backend", so an empty or half-loaded DB silently deletes the live blog. The
  server path refuses to sync when the backend reports zero published articles
  while Framer holds many, or when removals exceed a configured share of the
  collection. It alerts instead of proceeding.
- **Append-only fields.** `setFields` passes existing field objects back with
  identical IDs so canvas variable bindings survive.
- **Rate limiter.** `maxPerHour = 10` in `routes/generate.ts` sits exactly at the
  new ceiling; the internal scheduler path uses its own daily cap instead.
- **Bot state in SQLite.** `proposed_title` and `bot_message_id` persist so a
  restart between gates can't orphan a job. Callbacks are idempotent — tapping
  Publish twice publishes once.
- **Single-flight lock** on the scheduler; `last_run_date` catches missed runs.

## Error handling

The Server API is explicitly not transactional. Each stage is wrapped
independently: a failed `addItems` logs to `sync_log` and alerts without aborting
the batch. Connections are per-operation with guaranteed disconnect. Publish
retries once with backoff, then fails loudly. Generation failures land as
`generation_failed` without blocking the serial queue. Translation failure flags
`ru_missing` at gate 2 and offers publish-EN-only or retry.

## Testing

- `framer-api` behind a thin port interface; tests never hit the network
- Pure units: rotation cursor, top-up decision, probation filtering, random pick,
  debounce, wipe-guard predicate, item builder (currently untested — lives in the
  plugin today)
- Mock Anthropic for `proposeTitle()` and the seeder
- `SCHEDULER_DRY_RUN=1` — selection, titles and digest, no generation
- Clear the two `TODOS.md` items for `translator.ts` and the generator
  schema-retry path; translation now runs unattended up to 10x/night

## Topic pool state

**Purged 2026-08-19:** 767 pending + 3 approved Era rows deleted; `era-gap` and
`gsc` were already empty. Remaining usable pool: **5 pending seeded + 5
approved seeded/custom** — roughly one night at 5-10/night, confirming the
seeding rotation is required from night one.

### Original tally (2026-08-18)

The queue shows **772 pending** topics, but these are overwhelmingly Era/GSC rows
that largely duplicate already-published articles. They are to be purged, not
consumed:

```
DELETE /api/research/keywords?source=era        (&status=approved)
DELETE /api/research/keywords?source=era-gap    (&status=approved)
DELETE /api/research/keywords?source=gsc        (&status=approved)
```

The endpoint only accepts `pending` and `approved`, one source at a time; run both
statuses for each source. After purging, count the remaining `source='seeded'`
rows — that is the real runway. Assume it is small, so **the seeding rotation is
needed from night one**, not deferred.

That Era rows duplicated published articles is direct evidence for the
already-covered block under Anti-repetition: an unfiltered topic source drifts
into re-covering existing content, and only an explicit exclusion list prevents it.

## Rollout

0. **Purge Era/GSC keywords** and count remaining seeded topics.
1. ~~Spike: can the Server API adopt the `seobtn` collection?~~ **Done — no.**
   See "Spike result" above; migration to an API-owned collection is required.
2. Node 22 bump, add `framer-api`
3. `settings` table, Settings UI, niche/subniche/angle expansion
4. `proposeTitle()` + `titleOverride` in `generateArticle()`
5. Telegram bot, webhook, digests
6. Scheduler, caps, dry-run mode
7. `framer-sync.ts`, wipe guard, debounced publish
8. Host `plugin/dist`, switch to "Open Plugin from URL"

Run at 1-2/night for a week with the three new niches on probation before opening
up to 5-10.

## Known content issues

- **Route structure is correct — earlier concerns retracted (2026-08-19).**
  `/blog/<slug>` is the canonical public route: the sitemap lists 616 `/blog/`
  URLs, project Redirects map `/articles/* → /blog/:1`, and canonical tags point
  to `/blog/<slug>` accordingly. The generator's `<a href="/blog/slug">` internal
  links are therefore CORRECT and must not be changed to `/articles/`. All 308
  published articles appear in the sitemap and serve real content.

  Two earlier claims in this doc were measurement errors and are withdrawn:
  "canonical tags point at soft 404s" and "articles are not reachable".

  **Root cause of the false readings: Framer serves a ~56 KB shell on the FIRST
  request to a cold URL, and the full ~550 KB pre-rendered article on the second.**
  Reproduced 4/4 on distinct slugs after a publish (a publish invalidates the
  cache, so every URL goes cold again). Any single-request probe of a cold URL
  reads as a 404 shell. **Always request twice, or warm the URL first, before
  concluding a page is missing.**

  **Open question worth investigating (AEO-relevant):** the cold response carries
  the homepage `<title>` and no article content. A crawler that does not execute
  JS and does not retry — which describes most LLM/answer-engine crawlers, the
  exact audience this system targets — could see a contentless shell on first
  fetch. Verify with server logs or by testing cold URLs with an LLM-crawler user
  agent before treating it as a defect.

- **Literal "placeholder" text** in 6 of 308 articles (5 as a trailing text
  node). No code emits it — it is model output that survived sanitisation. Add a
  generator check and clean the affected articles.
- **Unreachable route:** `GET /api/articles/translate-status` is shadowed by
  `GET /api/articles/:id` (registered first), so it always returns "Article not
  found". The plugin's `getTranslationStatus()` polling has never worked. Move
  the literal route above the parameterised one.

## Open risks

- ~~Server API collection adoption~~ — settled: not possible, migration required.
- **CMS page rebinding** — whether a Framer CMS page's source collection can be
  changed in place, or the page must be recreated. Verify before deleting the
  legacy collection.
- **Content volume vs citation credibility.** ~225 articles/month of AI-generated
  content aimed at being cited as a credible source. The two gates are the control;
  if citation rate per article falls as volume climbs, volume is the first thing
  to look at.
- **Server API pricing** post-beta is unannounced; the debounced single-deploy
  design is what keeps that exposure small.
- **Thin-KB niches** may produce generic topics until KB pages exist. Probation
  plus the gate-1 digest is the detection mechanism.
