# TODOS

Deferred work tracked from /plan-ceo-review (2026-05-08), /plan-eng-review (2026-05-11), and /review (2026-05-14) on the Era AI content pivot.

## P1 — Next iteration (after Era pivot ships)

### 30-day Era-experiment retro
**What:** Review Era dashboard data 30 days after Era AI pivot ships. Decide: extend, kill, or pivot.
**Why:** The pivot's core assumption is that Era AI keywords + AEO-shaped articles produce LLM citations. Without a planned retro, we'd drift without learning whether the bet paid off.
**Context:** Set a calendar reminder for 2026-06-10. At that point, compare Era's Visibility/Citations dashboard against the pre-pivot baseline. Explicitly check Era's measurement against any anecdotal LLM citation observations (manually ask ChatGPT/Perplexity/Claude about CRMChat and see if articles get cited).
**Depends on:** Era AI pivot shipped.

### Russian-language keyword sourcing
**What:** Pick a separate keyword source for /ru/ content. Era's API has NO locale parameter (confirmed during the era.ts spike) — it returns whatever queries the LLMs generated, effectively English-only.
**Why:** /ru/ traffic is the dominant audience based on GSC data. English-only sourcing under-serves them.
**Context:** Candidates: Yandex Wordstat API, manual research, or alternative AEO tool with Russian support. Highest-leverage follow-up because Russian is the actual converting audience. Confirmed live (not conditional) — the spike showed Era is locale-agnostic with no filtering controls.
**Depends on:** Nothing — ready to start.

### Backfill tests for translator.ts and the generator schema-retry path
**What:** (a) `translator.ts` has NO test file — the per-locale schema_jsonld translation + validate-and-drop paths are untested. (b) `generator.ts`'s `validateOrRegenerateSchema` / `regenerateSchemaJsonld` have zero coverage — only the pure `sanitizeJsonLd` predicate (now in `src/lib/jsonld.test.ts`) is tested.
**Why:** Both are LLM-output-handling paths with retry/fallback logic. The retry-succeeds, retry-still-invalid-drops, and retry-throws-drops branches are exactly where silent failures hide.
**Context:** Add `translator.test.ts` (mock the Anthropic client: valid translated schema persisted, invalid dropped to '', no-source produces empty schemaBlock, manual-recovery regex extracts content correctly). Add `generator.test.ts` for `validateOrRegenerateSchema` (valid-first-pass, invalid-then-valid, invalid-twice, retry-throws). ~40 min CC. Flagged by the testing specialist during /review; deferred by explicit choice to keep this review's commit focused.
**Depends on:** Nothing — ready to start.

## P2 — Diagnostic resilience

### Independent LLM-citation polling script
**What:** Build a script that polls ChatGPT, Perplexity, and Claude APIs weekly with ~20 CRMChat-relevant queries and logs whether CRMChat appears in each answer. ~30 min CC.
**Why:** Era dashboard is currently the single source of truth for AEO success. If Era's tracking is wrong or biased, we won't know without independent measurement.
**Context:** Store in `src/services/citation-check.ts`. Cron via existing queue infrastructure. Output to a new `citation_checks` table. Cost ~$5-10/month in API fees.
**Depends on:** Anthropic, OpenAI, Perplexity API keys configured.

### AEO prompt quality eval suite
**What:** Eval suite testing that generated articles match all 4 winner-pattern rules (pain-driven opener, specific numeric first H2, ≥2 brand-mention sentences, tactical numbered list).
**Why:** Without an eval, we can't tell if prompt iterations are improving or degrading article quality.
**Context:** Baseline against the 2 currently winning articles. Use Anthropic's evaluator API or a homemade scorer. Run on every prompt change, fail PR if score regresses.
**Depends on:** ≥5 articles generated under new AEO prompt to have a test corpus.

### Schema validation in CI
**What:** Test that runs Google's Rich Results Test API (or a local validator) against generated `schema_jsonld` output. Catches malformed schema before publishing.
**Why:** Validate-and-retry guard catches JSON parse errors at runtime, but doesn't catch schema.org spec violations (wrong @type, missing required fields, etc.).
**Context:** Add to CI as part of generator test suite. Use schema.org's official validator or `structured-data-testing-tool` npm package.
**Depends on:** Generator schema test from this PR landing first.

### Era opportunity_score is batch-relative, and sov=null counts as max opportunity
**What:** `era.ts` normalizes `count` via min-max within each fetched batch — so a batch of all-low-count queries still produces 90+ scores, and a single-element batch always scores 100. Separately, `sov === null` is treated as `sovScore = 100` (maximum opportunity), but Era returning null likely means "not yet measured," not "0% share of voice." This systematically promotes unmeasured queries to the top.
**Why:** The `ERA_SCORE_FILTER = 30` threshold does little when scores are batch-relative. New/unmeasured queries jump the queue.
**Context:** Flagged by the adversarial reviewer during /review. Deliberately deferred — the CEO plan said scoring would be tuned after the first real run produces data. Revisit alongside the 30-day Era retro: look at the actual score distribution and decide whether to (a) use absolute count thresholds, (b) treat sov=null as a neutral/low score instead of max, or (c) keep batch-relative but document it.
**Depends on:** First real Era research run + 30-day retro data.

## P3 — Cleanup and automation

### Dead-article cleanup script
**What:** Automate the manual "delete underperforming articles" workflow.
**Why:** User deleted 38 articles manually for this pivot. If we generate hundreds more, this becomes painful at scale.
**Context:** Script: select articles below click threshold (configurable, default <5 clicks/month) AND older than N days (configurable, default 60). Mark for review or auto-delete with audit log.
**Depends on:** Per-article click tracking infrastructure (currently we infer from GSC, not stored).

### Per-intent generators
**What:** Split generator.ts into per-intent prompts: AEO articles, comparison pages (CRMChat vs X), problem-pain articles (winner pattern), tutorial articles.
**Why:** AEO is one intent. Different intents need different content shapes. One generator trying to do all four produces blurred outputs.
**Context:** Phase 2 of the multi-source AEO platform vision from the CEO plan's 10x check. Likely a router that picks the prompt template based on keyword classification.
**Depends on:** Era-experiment retro showing AEO works, then we expand.

### Full end-to-end test
**What:** E2E test that runs the full pipeline: trigger Era research → generated article → published → /api/sync/collection emits article with valid schema_jsonld + valueByLocale maps.
**Why:** Unit tests cover each step but not the full integration path. Most failures happen at integration boundaries.
**Context:** Use existing vitest infrastructure. Mock Era API and Anthropic API. Assert the full /collection response shape.
**Depends on:** Unit tests from this PR landing first.
