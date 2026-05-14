# TODOS

Deferred work tracked from /plan-ceo-review (2026-05-08) and /plan-eng-review (2026-05-11) on the Era AI content pivot.

## P1 — Next iteration (after Era pivot ships)

### 30-day Era-experiment retro
**What:** Review Era dashboard data 30 days after Era AI pivot ships. Decide: extend, kill, or pivot.
**Why:** The pivot's core assumption is that Era AI keywords + AEO-shaped articles produce LLM citations. Without a planned retro, we'd drift without learning whether the bet paid off.
**Context:** Set a calendar reminder for 2026-06-10. At that point, compare Era's Visibility/Citations dashboard against the pre-pivot baseline. Explicitly check Era's measurement against any anecdotal LLM citation observations (manually ask ChatGPT/Perplexity/Claude about CRMChat and see if articles get cited).
**Depends on:** Era AI pivot shipped.

### Russian-language keyword sourcing
**What:** If Era AI's API turned out to be English-only (revealed during the era.ts spike), pick a separate source for /ru/ content keywords.
**Why:** /ru/ traffic is the dominant audience based on GSC data. English-only sourcing under-serves them.
**Context:** Candidates: Yandex Wordstat API, manual research, or alternative AEO tool with Russian support. Highest-leverage follow-up because Russian is the actual converting audience.
**Depends on:** Era spike outcome (only do this if Era is en-only).

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

## P2 — Post-PR cleanup (discovered during implementation)

### Remove orphaned GSC scoring infrastructure
**What:** With Era pass-through, `scoring.ts` (GSC scoring formula) and the `/api/research/rescore` endpoint are functionally dead. Delete `src/services/scoring.ts`, `src/services/scoring.test.ts`, the `/rescore` route in `src/routes/research.ts`, the `rescoreKeywords()` method in `plugin/src/api/client.ts`, and the rescore button call in `plugin/src/App.tsx:56`.
**Why:** Dead code rots. Currently if a user clicks rescore in the plugin, it overwrites valid Era scores with 0 (NULL impressions/ctr/position → score=0). Active footgun.
**Context:** Left in place during the Era pivot PR because it touched the plugin UI and was out of declared scope. Self-contained cleanup, ~15 min CC.
**Depends on:** Era pivot landing first.

### Fix or delete pre-existing scoring.test.ts failures
**What:** `src/services/scoring.test.ts` has 6 failing tests (verified against pre-Era-pivot HEAD). The test expects `positionWeight(1)` to return 0.1 but the implementation returns 0.05. The scoring formula was updated at some point but the test wasn't.
**Why:** Failing tests in CI mask real regressions.
**Context:** Either delete scoring.test.ts as part of the orphaned-infrastructure cleanup above, OR update the test expectations to match the current implementation. ~5 min either way.
**Depends on:** Decision on whether scoring.ts is kept or deleted.

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
