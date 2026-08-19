# SEO Autopilot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run 5-10 articles per night unattended, gated by two Telegram approvals (titles, then finished articles), with Framer CMS sync and site publish driven from Railway.

**Architecture:** The existing Hono service gains an in-process scheduler plus three services — `framer-sync.ts` (Framer Server API), `notify.ts` (Telegram), `title.ts` (`proposeTitle`). A `settings` key/value table holds the niche taxonomy and runtime config so tuning needs no redeploy. All decision logic (rotation, selection, guards) is written as **pure functions** so it is unit-testable without network or DB.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, better-sqlite3, vitest, `@anthropic-ai/sdk`, `framer-api` (Node >= 22), Telegram Bot API.

**Design reference:** `docs/plans/2026-08-18-seo-autopilot-design.md` — read it before starting. Key verified facts:
- Framer collection `kqBHLapEf` ("CRMChat SEO Engine (API)"), locale `ru` → `mG5aB_oJw`
- Framer resolves relative hrefs to CMS references **at ingest time**; syncing into a collection not bound to a CMS page silently kills every internal link, and this is **invisible to the Server API**
- `/api/sync/collection` already emits Framer-shaped items with `{action:"set", value}` locale maps
- A cold Framer URL returns a ~56 KB shell on first request — always request twice before concluding a page is missing

---

## Conventions for every task

- **TDD:** write the failing test, run it, watch it fail, implement, watch it pass, commit.
- Run tests with `npx vitest run <path>` (single file) or `npx vitest run` (all).
- Type-check with `npx tsc --noEmit` before each commit.
- Tests live beside the code: `src/services/foo.ts` → `src/services/foo.test.ts`.
- Never call the network in a test. Anthropic, Telegram and Framer all go behind interfaces.
- Commit after each task. Small commits.

---

## Task 0: Runtime prerequisites

**Files:**
- Modify: `Dockerfile:1`
- Modify: `package.json` (dependencies)

**Step 1: Bump the base image**

`framer-api` declares `engines: { node: ">=22" }`. The Dockerfile pins Node 20, so the container cannot run it.

In `Dockerfile` line 1, change:
```dockerfile
FROM node:20-slim
```
to:
```dockerfile
FROM node:22-slim
```

**Step 2: Add the dependency**

Run: `npm install framer-api`

**Step 3: Verify the build still compiles**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

**Step 4: Verify the container builds**

Run: `docker build -t seo-engine-test .` (skip if Docker is unavailable locally; Railway will catch it)
Expected: build succeeds.

**Step 5: Commit**

```bash
git add Dockerfile package.json package-lock.json
git commit -m "chore: bump to Node 22 and add framer-api"
```

---

## Task 1: Settings table and service

A key/value store for the niche taxonomy, rotation cursor, schedule config and Framer/Telegram identifiers. Values are JSON.

**Files:**
- Modify: `src/db/schema.sql` (append)
- Create: `src/services/settings.ts`
- Test: `src/services/settings.test.ts`

**Step 1: Add the table to the schema**

Append to `src/db/schema.sql`:

```sql
-- Runtime configuration (niche taxonomy, rotation cursor, schedule).
-- Values are JSON documents so config can evolve without migrations.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`initDb()` runs `schema.sql` on every boot with `CREATE TABLE IF NOT EXISTS`, so no separate migration is needed.

**Step 2: Write the failing test**

Create `src/services/settings.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { getSetting, setSetting, __setTestDb } from "./settings.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
           updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  __setTestDb(db);
});

describe("settings", () => {
  it("returns the fallback when a key is absent", () => {
    expect(getSetting("nope", { a: 1 })).toEqual({ a: 1 });
  });

  it("round-trips a JSON value", () => {
    setSetting("niches", [{ name: "Web3" }]);
    expect(getSetting("niches", [])).toEqual([{ name: "Web3" }]);
  });

  it("overwrites an existing key rather than erroring", () => {
    setSetting("cursor", 1);
    setSetting("cursor", 2);
    expect(getSetting("cursor", 0)).toBe(2);
  });

  it("returns the fallback when the stored value is corrupt JSON", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('bad', '{oops')").run();
    expect(getSetting("bad", "safe")).toBe("safe");
  });
});
```

**Step 3: Run it and watch it fail**

Run: `npx vitest run src/services/settings.test.ts`
Expected: FAIL — `Cannot find module './settings.js'`

**Step 4: Implement**

Create `src/services/settings.ts`:

```typescript
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";

// Tests inject an in-memory DB; production reads the real one.
let testDb: Database.Database | null = null;
export function __setTestDb(db: Database.Database | null): void {
  testDb = db;
}
function db(): Database.Database {
  return testDb ?? getDb();
}

/**
 * Read a JSON setting. Returns `fallback` when the key is missing or the stored
 * value fails to parse — a corrupt row must not take the scheduler down.
 */
export function getSetting<T>(key: string, fallback: T): T {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    logger.warn({ key }, "Corrupt settings value — using fallback");
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, JSON.stringify(value));
}
```

**Step 5: Run and verify green**

Run: `npx vitest run src/services/settings.test.ts`
Expected: 4 passed.

**Step 6: Commit**

```bash
git add src/db/schema.sql src/services/settings.ts src/services/settings.test.ts
git commit -m "feat: add settings key/value store"
```

---

## Task 2: Niche taxonomy and rotation cursor

Pure logic — no DB, no network. This is the heart of topic supply, so it gets thorough tests.

**Files:**
- Create: `src/services/taxonomy.ts`
- Test: `src/services/taxonomy.test.ts`

**Step 1: Write the failing test**

Create `src/services/taxonomy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { nextSlot, DEFAULT_NICHES, ANGLES, countSlots } from "./taxonomy.js";

const niches = [
  { name: "A", persona: "pa", subniches: ["a1", "a2"], probation: false, kb_hints: [] },
  { name: "B", persona: "pb", subniches: ["b1"], probation: false, kb_hints: [] },
];

describe("nextSlot", () => {
  it("returns the first slot at cursor 0", () => {
    expect(nextSlot(niches, 0)).toEqual({
      niche: niches[0], subniche: "a1", angle: ANGLES[0], cursor: 1,
    });
  });

  it("advances through angles before subniches", () => {
    expect(nextSlot(niches, 1).angle).toBe(ANGLES[1]);
    expect(nextSlot(niches, 1).subniche).toBe("a1");
  });

  it("advances to the next subniche after exhausting angles", () => {
    const s = nextSlot(niches, ANGLES.length);
    expect(s.subniche).toBe("a2");
    expect(s.angle).toBe(ANGLES[0]);
  });

  it("advances to the next niche after exhausting its subniches", () => {
    const s = nextSlot(niches, ANGLES.length * 2);
    expect(s.niche.name).toBe("B");
  });

  it("wraps around to the start", () => {
    const total = countSlots(niches);
    expect(nextSlot(niches, total).niche.name).toBe("A");
    expect(nextSlot(niches, total).cursor).toBe(total + 1);
  });

  it("skips niches on probation", () => {
    const withProbation = [{ ...niches[0], probation: true }, niches[1]];
    expect(nextSlot(withProbation, 0).niche.name).toBe("B");
  });

  it("returns null when every niche is on probation", () => {
    expect(nextSlot(niches.map((n) => ({ ...n, probation: true })), 0)).toBeNull();
  });

  it("ships 8 default niches, 3 of them on probation", () => {
    expect(DEFAULT_NICHES).toHaveLength(8);
    expect(DEFAULT_NICHES.filter((n) => n.probation)).toHaveLength(3);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run src/services/taxonomy.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

Create `src/services/taxonomy.ts`:

```typescript
export interface Niche {
  name: string;
  /** A persona SENTENCE, not a label — seedTopics grounds on searchKB(audience). */
  persona: string;
  subniches: string[];
  /** KB filenames to force-include as grounding ahead of TF-IDF matches. */
  kb_hints: string[];
  /** Probationary niches are seeded but excluded from auto-pick until approved. */
  probation: boolean;
}

export interface Slot {
  niche: Niche;
  subniche: string;
  angle: string;
  cursor: number;
}

export const ANGLES = ["how-to", "comparison", "migration", "troubleshooting", "pricing"] as const;

export function countSlots(niches: Niche[]): number {
  return niches.reduce((n, x) => n + Math.max(1, x.subniches.length) * ANGLES.length, 0);
}

/**
 * Walk niche → subniche → angle in a stable order so the cursor can be persisted
 * across restarts. Probationary niches are still seeded (their topics land as
 * pending for manual review) but are skipped by the auto-picker, so they are
 * excluded here too.
 */
export function nextSlot(niches: Niche[], cursor: number): Slot | null {
  const active = niches.filter((n) => !n.probation && n.subniches.length > 0);
  if (active.length === 0) return null;

  const total = countSlots(active);
  const idx = ((cursor % total) + total) % total;

  let seen = 0;
  for (const niche of active) {
    for (const subniche of niche.subniches) {
      for (const angle of ANGLES) {
        if (seen === idx) return { niche, subniche, angle, cursor: cursor + 1 };
        seen++;
      }
    }
  }
  return null; // unreachable
}

export const DEFAULT_NICHES: Niche[] = [
  {
    name: "Web3 / crypto",
    persona: "Web3 BD leads at DeFi protocols and crypto funds running partnership outreach on Telegram",
    subniches: ["DeFi protocols", "crypto funds and VCs", "token launchpads", "NFT and gaming studios", "conference and event teams", "market makers"],
    kb_hints: ["industry-web3-crypto.md", "product-web3-database.md"],
    probation: false,
  },
  {
    name: "B2B lead-gen agencies",
    persona: "B2B lead generation agency owners delivering Telegram outreach as a service for client campaigns",
    subniches: ["boutique agencies", "enterprise GTM firms", "SaaS-focused agencies", "appointment setting teams", "white-label providers", "freelance SDRs"],
    kb_hints: ["industry-leadgen-agencies.md", "case-study-lead-sniper.md"],
    probation: false,
  },
  {
    name: "iGaming affiliates",
    persona: "iGaming affiliate managers driving casino and betting FTDs from Meta traffic into Telegram",
    subniches: ["casino affiliates", "sportsbook affiliates", "traffic networks", "affiliate program managers", "media buying teams", "VIP player managers"],
    kb_hints: ["industry-igaming.md"],
    probation: false,
  },
  {
    name: "Creator / OnlyFans agencies",
    persona: "Content creator agency operators managing multiple model accounts, chatters and PPV sales in Telegram DMs",
    subniches: ["model management agencies", "chatter teams", "PPV sales operations", "fan migration from other platforms", "solo creators scaling up", "agency owners hiring chatters"],
    kb_hints: ["creator-agency-telegram.md", "product-ppv-bot.md"],
    probation: false,
  },
  {
    name: "Media buying",
    persona: "Media buying providers finding and closing media buyers through Telegram communities",
    subniches: ["performance agencies", "traffic arbitrage teams", "ad network sales", "affiliate media buyers", "in-house growth teams", "creative studios"],
    kb_hints: ["industry-media-buying.md"],
    probation: false,
  },
  {
    name: "RU B2B SaaS",
    persona: "Russian-speaking B2B SaaS founders and sales leads finding decision-makers across RU/CIS where LinkedIn is unavailable",
    subniches: ["HR tech", "fintech SaaS", "logistics and supply chain", "martech", "edtech", "devtools"],
    kb_hints: ["finding-decision-makers-ru-cis.md", "product-lead-research.md"],
    probation: true,
  },
  {
    name: "RU AI companies",
    persona: "Russian-speaking AI product teams and integrators selling automation services to businesses over Telegram",
    subniches: ["AI integrators", "chatbot studios", "ML consultancies", "AI SaaS products", "automation agencies", "no-code AI builders"],
    kb_hints: ["finding-decision-makers-ru-cis.md", "telegram-ai-sales-agent.md"],
    probation: true,
  },
  {
    name: "Online currency exchanges",
    persona: "Operators of online currency and crypto exchange desks handling client trades and support entirely in Telegram",
    subniches: ["P2P exchange desks", "crypto-fiat exchangers", "forex signal desks", "OTC trading desks", "payment rail operators", "regional exchange networks"],
    kb_hints: ["industry-web3-crypto.md", "product-telegram-crm.md"],
    probation: true,
  },
];
```

**Step 4: Run and verify green**

Run: `npx vitest run src/services/taxonomy.test.ts`
Expected: 8 passed.

**Step 5: Commit**

```bash
git add src/services/taxonomy.ts src/services/taxonomy.test.ts
git commit -m "feat: add niche/subniche/angle taxonomy and rotation cursor"
```

---

## Task 3: Topic selection

Pure function deciding which pending topics become tonight's articles. **This is where the Era filter lives** — Era rows are permanently excluded.

**Files:**
- Create: `src/services/selection.ts`
- Test: `src/services/selection.test.ts`

**Step 1: Write the failing test**

Create `src/services/selection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { selectTopics, needsTopUp } from "./selection.js";

const t = (id: string, source: string) => ({ id, query: `q-${id}`, source });

describe("selectTopics", () => {
  it("excludes era and gsc rows entirely", () => {
    const picked = selectTopics(
      [t("1", "era"), t("2", "era-gap"), t("3", "gsc"), t("4", "seeded")],
      5,
      () => 0
    );
    expect(picked.map((p) => p.id)).toEqual(["4"]);
  });

  it("accepts seeded and custom sources", () => {
    const picked = selectTopics([t("1", "seeded"), t("2", "custom")], 5, () => 0);
    expect(picked).toHaveLength(2);
  });

  it("never returns more than the requested count", () => {
    const pool = Array.from({ length: 20 }, (_, i) => t(String(i), "seeded"));
    expect(selectTopics(pool, 7, () => 0)).toHaveLength(7);
  });

  it("returns everything available when the pool is smaller than the count", () => {
    expect(selectTopics([t("1", "seeded")], 10, () => 0)).toHaveLength(1);
  });

  it("never returns the same topic twice", () => {
    const pool = Array.from({ length: 5 }, (_, i) => t(String(i), "seeded"));
    const ids = selectTopics(pool, 5, () => 0.999).map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("uses the injected RNG so selection is deterministic under test", () => {
    const pool = [t("a", "seeded"), t("b", "seeded"), t("c", "seeded")];
    expect(selectTopics(pool, 1, () => 0)).toEqual([pool[0]]);
  });
});

describe("needsTopUp", () => {
  it("tops up when the usable pool is below the threshold", () => {
    expect(needsTopUp([t("1", "seeded")], 10)).toBe(true);
  });

  it("does not count era rows toward the threshold", () => {
    const pool = Array.from({ length: 50 }, (_, i) => t(String(i), "era"));
    expect(needsTopUp(pool, 10)).toBe(true);
  });

  it("does not top up when there are enough usable topics", () => {
    const pool = Array.from({ length: 12 }, (_, i) => t(String(i), "seeded"));
    expect(needsTopUp(pool, 10)).toBe(false);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run src/services/selection.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

Create `src/services/selection.ts`:

```typescript
export interface PendingTopic {
  id: string;
  query: string;
  source: string;
}

/**
 * Era/OhMyGEO was retired — its rows largely duplicated already-published
 * articles. Only self-seeded and hand-entered topics are eligible.
 */
const USABLE_SOURCES = new Set(["seeded", "custom"]);

function usable(topics: PendingTopic[]): PendingTopic[] {
  return topics.filter((t) => USABLE_SOURCES.has(t.source));
}

/**
 * Pick `count` topics at random from the usable pool.
 * `rng` is injected so tests are deterministic.
 */
export function selectTopics(
  topics: PendingTopic[],
  count: number,
  rng: () => number = Math.random
): PendingTopic[] {
  const pool = [...usable(topics)];
  const picked: PendingTopic[] = [];
  while (picked.length < count && pool.length > 0) {
    const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

export function needsTopUp(topics: PendingTopic[], threshold: number): boolean {
  return usable(topics).length < threshold;
}
```

**Step 4: Run and verify green**

Run: `npx vitest run src/services/selection.test.ts`
Expected: 9 passed.

**Step 5: Commit**

```bash
git add src/services/selection.ts src/services/selection.test.ts
git commit -m "feat: add topic selection with permanent Era exclusion"
```

---

## Task 4: Seeder — angle constraint, KB hints, already-covered exclusion

The anti-repetition change. Without it, rotation drifts into near-duplicates that cannibalise each other in search.

**Files:**
- Modify: `src/services/seeder.ts` (`seedTopics`, `generateTopicCandidates`)
- Test: `src/services/seeder.prompt.test.ts`

**Step 1: Write the failing test**

Create `src/services/seeder.prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSeederPrompt } from "./seeder.js";

describe("buildSeederPrompt", () => {
  const base = {
    audience: "Web3 BD leads",
    subniche: "crypto funds and VCs",
    angle: "migration",
    kbContext: "KB text",
    covered: ["existing topic one", "existing topic two"],
    count: 10,
  };

  it("names the angle as a hard constraint", () => {
    expect(buildSeederPrompt(base).toLowerCase()).toContain("migration");
  });

  it("names the subniche", () => {
    expect(buildSeederPrompt(base)).toContain("crypto funds and VCs");
  });

  it("lists already-covered topics so Claude avoids them", () => {
    const p = buildSeederPrompt(base);
    expect(p).toContain("existing topic one");
    expect(p).toContain("existing topic two");
  });

  it("omits the covered block entirely when nothing is covered yet", () => {
    const p = buildSeederPrompt({ ...base, covered: [] });
    expect(p).not.toMatch(/already covered/i);
  });

  it("caps the covered list so the prompt cannot grow unbounded", () => {
    const many = Array.from({ length: 500 }, (_, i) => `topic ${i}`);
    const p = buildSeederPrompt({ ...base, covered: many });
    expect(p).not.toContain("topic 400");
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run src/services/seeder.prompt.test.ts`
Expected: FAIL — `buildSeederPrompt` is not exported.

**Step 3: Implement**

In `src/services/seeder.ts`, add the exported prompt builder and use it inside `generateTopicCandidates`:

```typescript
const MAX_COVERED = 90;

export interface SeederPromptInput {
  audience: string;
  subniche: string;
  angle: string;
  kbContext: string;
  covered: string[];
  count: number;
}

/**
 * Build the user message for topic generation.
 *
 * The `covered` block is the anti-repetition mechanism: on a fixed rotation the
 * model will otherwise re-propose the same territory every cycle. Exact-duplicate
 * queries are already rejected by insertSeededTopics, but NEAR-duplicates pass
 * through and then compete with each other in search — so they must be prevented
 * at generation time, not filtered afterwards.
 */
export function buildSeederPrompt(input: SeederPromptInput): string {
  const { audience, subniche, angle, kbContext, covered, count } = input;
  const trimmed = covered.slice(0, MAX_COVERED);

  return `TARGET AUDIENCE: ${audience}
SUBNICHE (narrow every topic to this): ${subniche}
ANGLE (every topic must take this angle): ${angle}
${kbContext ? `\nCRMChat KNOWLEDGE BASE (ground topics in this — do not invent features):\n${kbContext}` : "\n(No specific KB context matched — propose topics from CRMChat's general Telegram CRM/outreach positioning.)"}
${trimmed.length > 0 ? `\nALREADY COVERED — do NOT propose these or close variations of them. Propose adjacent territory instead:\n${trimmed.map((t) => `- ${t}`).join("\n")}` : ""}

Propose ${count} AEO-optimized article topics for this audience, all within the "${subniche}" subniche and all taking the "${angle}" angle. Call emit_topics.`;
}
```

Update `generateTopicCandidates(...)` to accept the same input and pass `buildSeederPrompt(input)` as the user message content. In the system prompt, replace the line `- Cover a spread of angles across the batch...` with:

```
- EVERY topic in this batch must take the same angle, given below. Do not vary the angle.
```

Extend `seedTopics(...)` to accept `{ subniche, angle, kbHints, covered }` and to prepend `kbHints` documents to the `searchKB` results before truncation.

Add a helper that reads the covered list:

```typescript
/** Recent topic queries plus published titles — the exclusion list for seeding. */
export function getCoveredTopics(limit = 60): string[] {
  const db = getDb();
  const queries = db
    .prepare("SELECT query FROM keywords ORDER BY created_at DESC LIMIT ?")
    .all(limit) as { query: string }[];
  const titles = db
    .prepare("SELECT title FROM articles WHERE status = 'published' ORDER BY published_at DESC LIMIT 30")
    .all() as { title: string }[];
  return [...queries.map((q) => q.query), ...titles.map((t) => t.title)];
}
```

**Step 4: Run and verify green**

Run: `npx vitest run src/services/seeder.prompt.test.ts && npx tsc --noEmit`
Expected: 5 passed, no type errors.

**Step 5: Commit**

```bash
git add src/services/seeder.ts src/services/seeder.prompt.test.ts
git commit -m "feat: seed by subniche+angle with already-covered exclusion"
```

---

## Task 5: proposeTitle

Gate 1 needs a real headline before generation. Reuses the existing ban-list so a proposed title obeys the same rules as a generated one.

**Files:**
- Create: `src/services/title.ts`
- Test: `src/services/title.test.ts`

**Step 1: Write the failing test**

Create `src/services/title.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { proposeTitle } from "./title.js";

const client = (titles: string[]) => {
  let i = 0;
  return {
    propose: vi.fn(async () => titles[i++] ?? "Fallback Title"),
  };
};

describe("proposeTitle", () => {
  it("returns the model's title when it is clean", async () => {
    const c = client(["Your Sales Team Runs on Telegram"]);
    expect(await proposeTitle("topic", [], [], c)).toBe("Your Sales Team Runs on Telegram");
  });

  it("retries once when the title contains a banned tic", async () => {
    const c = client(["The Ultimate Guide to Telegram", "Telegram CRM Without the Guesswork"]);
    const out = await proposeTitle("topic", [], [], c);
    expect(out).toBe("Telegram CRM Without the Guesswork");
    expect(c.propose).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry and returns the second attempt", async () => {
    const c = client(["Ultimate Guide", "Complete Guide"]);
    const out = await proposeTitle("topic", [], [], c);
    expect(out).toBe("Complete Guide");
    expect(c.propose).toHaveBeenCalledTimes(2);
  });

  it("passes recent titles to the client for shape variety", async () => {
    const c = client(["Fresh Title"]);
    await proposeTitle("topic", ["Recent One"], [], c);
    expect(c.propose).toHaveBeenCalledWith(
      expect.objectContaining({ recentTitles: ["Recent One"] })
    );
  });

  it("passes rejected titles so a reroll does not repeat them", async () => {
    const c = client(["Fresh Title"]);
    await proposeTitle("topic", [], ["Rejected One"], c);
    expect(c.propose).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: ["Rejected One"] })
    );
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run src/services/title.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

Create `src/services/title.ts`. Reuse `findTitleTics` from `generator.ts` (already exported at line 580):

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { findTitleTics } from "./generator.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

export interface TitleRequest {
  topic: string;
  recentTitles: string[];
  rejected: string[];
}

export interface TitleClient {
  propose(req: TitleRequest): Promise<string>;
}

/**
 * Propose a headline for a topic, before the article is written.
 *
 * Validates against the same ban-list the generator uses (findTitleTics) and
 * retries once. After one retry we accept whatever came back rather than
 * looping — the operator sees the title at gate 1 and can reroll or reject.
 */
export async function proposeTitle(
  topic: string,
  recentTitles: string[],
  rejected: string[],
  client: TitleClient = defaultClient()
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const title = (await client.propose({ topic, recentTitles, rejected })).trim();
    const tics = findTitleTics(title);
    if (tics.length === 0) return title;
    logger.warn({ title, tics, attempt }, "Proposed title has banned tics");
    if (attempt === 1) return title;
    rejected = [...rejected, title];
  }
  throw new Error("unreachable");
}

function defaultClient(): TitleClient {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    async propose({ topic, recentTitles, rejected }) {
      const res = await anthropic.messages.create({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 256,
        system: `You write article headlines for CRMChat, a Telegram-native CRM and outreach platform.

TITLE CRAFT:
- The title is the only thing most people read. Treat it as copywriting, not a label.
- Reframe the topic into a reader-facing headline — do NOT copy the topic phrase.
- HARD BAN: 'Actually', 'Really', 'Ultimate', 'Complete Guide', 'Everything You Need', 'A Deep Dive', 'No-Fluff', 'No-Agency', 'The Truth About', parenthetical subtitles like '(Step-by-Step)', and year suffixes like 'in 2026'.
- Vary shape: do not reuse the opening word, hook word, or colon-subtitle shape of the recent titles listed below.

Reply with the headline only. No quotes, no preamble.`,
        messages: [
          {
            role: "user",
            content: `TOPIC: ${topic}
${recentTitles.length ? `\nRECENT TITLES (do not echo their shape or opening word):\n${recentTitles.map((t) => `- ${t}`).join("\n")}` : ""}
${rejected.length ? `\nREJECTED — do not propose these or close variants:\n${rejected.map((t) => `- ${t}`).join("\n")}` : ""}`,
          },
        ],
      });
      const block = res.content.find((b) => b.type === "text");
      return block && block.type === "text" ? block.text : "";
    },
  };
}
```

**Step 4: Run and verify green**

Run: `npx vitest run src/services/title.test.ts`
Expected: 5 passed.

**Step 5: Commit**

```bash
git add src/services/title.ts src/services/title.test.ts
git commit -m "feat: add proposeTitle for the pre-generation approval gate"
```

---

## Task 6: Title override in generateArticle

The approved headline must survive into the article, or gate 1 is theatre.

**Files:**
- Modify: `src/services/generator.ts` (`generateArticle` signature, tool schema, `validateOrRegenerateTitle` call)
- Modify: `src/services/queue.ts` (`GenerationJob`)
- Modify: `src/db/schema.sql` (add `keywords.proposed_title`)
- Modify: `src/db/index.ts` (migration)
- Test: `src/services/generator.title-override.test.ts`

**Step 1: Add the column**

Append to the `keywords` table definition in `schema.sql`:
```sql
  proposed_title TEXT,
  bot_message_id INTEGER,
```
and add to `initDb()` in `src/db/index.ts`, next to the existing `addColumn` calls:
```typescript
addColumn("ALTER TABLE keywords ADD COLUMN proposed_title TEXT");
addColumn("ALTER TABLE keywords ADD COLUMN bot_message_id INTEGER");
```

**Step 2: Write the failing test**

Create `src/services/generator.title-override.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildTitleInstruction } from "./generator.js";

describe("buildTitleInstruction", () => {
  it("pins the approved title verbatim when one is supplied", () => {
    const out = buildTitleInstruction("My Approved Headline");
    expect(out).toContain("My Approved Headline");
    expect(out).toMatch(/exactly|verbatim/i);
  });

  it("falls back to the normal craft rules when no title is pinned", () => {
    const out = buildTitleInstruction(undefined);
    expect(out).toMatch(/HARD BAN/);
    expect(out).not.toMatch(/verbatim/i);
  });
});
```

**Step 3: Run it and watch it fail**

Run: `npx vitest run src/services/generator.title-override.test.ts`
Expected: FAIL — `buildTitleInstruction` is not exported.

**Step 4: Implement**

In `src/services/generator.ts`, extract the tool's `title` description (currently inline at line 327) into an exported function:

```typescript
export function buildTitleInstruction(approvedTitle?: string): string {
  if (approvedTitle) {
    return `Use this EXACT title, verbatim, with no changes: "${approvedTitle}". It has already been approved by the operator. Write the article body to fit this headline.`;
  }
  return `Article title. Reframe the keyword into a reader-friendly headline — do NOT just copy the keyword phrase. HARD BAN — your title MUST NOT contain any of: 'Actually', 'Really', 'Ultimate', 'Complete Guide', 'Everything You Need', 'A Deep Dive', 'No-Fluff', 'No-Agency', 'The Truth About', parenthetical subtitles like '(Step-by-Step)' / '(And Where Each Falls Short)', or year suffixes like 'in 2026'. These are AI-content tells that destroy citation credibility. See TITLE CRAFT in the system prompt for shape variety and reframe examples.`;
}
```

Use it in the tool schema: `title: { type: "string", description: buildTitleInstruction(approvedTitle) }`.

Change the signature to `generateArticle(keywordId: string, query: string, approvedTitle?: string)`, and **skip the title-tic regeneration when `approvedTitle` is set** — the operator already approved it, so silently rewriting it would break the gate's contract.

Add `titleOverride?: string` to `GenerationJob` in `queue.ts` and forward it.

**Step 5: Run and verify green**

Run: `npx vitest run src/services/generator.title-override.test.ts && npx tsc --noEmit`
Expected: 2 passed, no type errors.

**Step 6: Commit**

```bash
git add src/services/generator.ts src/services/queue.ts src/db/schema.sql src/db/index.ts src/services/generator.title-override.test.ts
git commit -m "feat: pin operator-approved titles through generation"
```

---

## Task 7: Chain translation after generation

Today `queue.ts` never triggers translation — it is a manual step. The autopilot needs the chain.

**Files:**
- Modify: `src/services/queue.ts:37-62` (`enqueueGeneration`)

**Step 1: Implement**

In `enqueueGeneration`, after a successful generation, enqueue translation:

```typescript
// Chain translation so an approved article reaches gate 2 with RU already done.
// Only for articles that actually generated — a generation_failed row has no
// content worth translating.
if (result.status !== "generation_failed") {
  enqueueTranslation({ articleId: result.articleId, force: false });
}
```

**Step 2: Verify the whole suite still passes**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

**Step 3: Commit**

```bash
git add src/services/queue.ts
git commit -m "feat: auto-enqueue RU translation after generation"
```

---

## Task 8: Telegram client

**Files:**
- Create: `src/services/notify.ts`
- Test: `src/services/notify.test.ts`
- Modify: `src/lib/env.ts`

**Step 1: Add env vars**

In `src/lib/env.ts`, add:
```typescript
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || "",
```

**Step 2: Write the failing test**

Create `src/services/notify.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildDigest, chunkText } from "./notify.js";

describe("buildDigest", () => {
  it("numbers each item so buttons map to positions", () => {
    const out = buildDigest("Titles ready", [{ label: "First" }, { label: "Second" }]);
    expect(out).toContain("1.");
    expect(out).toContain("2.");
  });

  it("includes the header", () => {
    expect(buildDigest("Titles ready", [])).toContain("Titles ready");
  });

  it("escapes HTML so a title with < cannot break the message", () => {
    const out = buildDigest("H", [{ label: "A < B & C" }]);
    expect(out).toContain("&lt;");
    expect(out).toContain("&amp;");
  });
});

describe("chunkText", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkText("short", 4096)).toHaveLength(1);
  });

  it("splits oversized text at the limit", () => {
    expect(chunkText("x".repeat(5000), 4096)).toHaveLength(2);
  });
});
```

**Step 3: Run it and watch it fail**

Run: `npx vitest run src/services/notify.test.ts`
Expected: FAIL — module not found.

**Step 4: Implement**

Create `src/services/notify.ts` with:
- `escapeHtml(s)` — `& < >` only (Telegram HTML parse mode)
- `buildDigest(header, items)` — numbered list
- `chunkText(text, limit)` — Telegram caps messages at 4096 chars
- `sendMessage(text, keyboard?)` — POST `https://api.telegram.org/bot<token>/sendMessage`, `chat_id` from env, `parse_mode: "HTML"`
- `sendDocument(filename, content, caption)` — POST `sendDocument` with multipart, used for the gate-2 `.html` attachment
- `editMessage(messageId, text)` — POST `editMessageText`, so a tapped button updates the message in place
- `answerCallback(callbackId, text)` — POST `answerCallbackQuery`

Every function must no-op with a warning when `TELEGRAM_BOT_TOKEN` is empty, so local development and tests never hit the network.

**Step 5: Run and verify green**

Run: `npx vitest run src/services/notify.test.ts`
Expected: 5 passed.

**Step 6: Commit**

```bash
git add src/services/notify.ts src/services/notify.test.ts src/lib/env.ts
git commit -m "feat: add Telegram notification client"
```

---

## Task 9: Telegram webhook and callback handling

**Files:**
- Create: `src/routes/telegram.ts`
- Test: `src/routes/telegram.test.ts`
- Modify: `src/index.ts` (mount the route)

**Security requirements — all three are mandatory:**
1. Verify the `X-Telegram-Bot-Api-Secret-Token` header equals `env.TELEGRAM_WEBHOOK_SECRET`; reject with 401 otherwise.
2. Verify the update's chat ID equals `env.TELEGRAM_CHAT_ID`; ignore silently otherwise.
3. The route is mounted **before** `authMiddleware` (Telegram cannot send a bearer token) — so items 1 and 2 are the only things standing between the internet and your generation budget.

**Callback data format:** `<action>:<entityId>` where action is one of
`gen` (approve title), `rrl` (reroll title), `rej` (reject topic),
`pub` (publish article), `rgn` (regenerate), `del` (delete),
`genall`, `puball`.

**Idempotency:** every handler must re-read current state from SQLite and no-op if the entity is already in the target state. Tapping *Publish* twice must publish once.

**Step 1: Write the failing test**

Create `src/routes/telegram.test.ts` covering:
- rejects a request with a wrong secret token (401)
- ignores an update from an unknown chat ID (200, no action)
- `parseCallback("pub:abc123")` → `{ action: "pub", id: "abc123" }`
- `parseCallback("garbage")` → `null`
- a second identical callback is a no-op

**Step 2-5:** implement, verify, commit as per convention.

```bash
git commit -m "feat: add Telegram webhook with chat allowlist and idempotent callbacks"
```

---

## Task 10: Framer sync with wipe guard and binding guard

The most dangerous component: it can delete 308 live articles. Two guards, both tested.

**Files:**
- Create: `src/services/framer-sync.ts`
- Test: `src/services/framer-sync.test.ts`

**Step 1: Write the failing test**

Create `src/services/framer-sync.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildItems, wipeGuard } from "./framer-sync.js";

const localeMap = new Map([["ru", "mG5aB_oJw"]]);

describe("buildItems", () => {
  it("remaps locale codes to Framer locale IDs", () => {
    const [item] = buildItems(
      [{ id: "1", slug: "s", fieldData: {
        title: { type: "string", value: "EN", valueByLocale: { ru: { action: "set", value: "RU" } } },
      } }],
      localeMap
    );
    expect(item.fieldData.title.valueByLocale).toEqual({ mG5aB_oJw: { action: "set", value: "RU" } });
  });

  it("drops valueByLocale entirely when no locale maps", () => {
    const [item] = buildItems(
      [{ id: "1", slug: "s", fieldData: {
        title: { type: "string", value: "EN", valueByLocale: { fr: { action: "set", value: "FR" } } },
      } }],
      localeMap
    );
    expect(item.fieldData.title).not.toHaveProperty("valueByLocale");
  });

  it("preserves item id and slug — item identity must never change", () => {
    const [item] = buildItems([{ id: "abc", slug: "my-slug", fieldData: {} }], localeMap);
    expect(item).toMatchObject({ id: "abc", slug: "my-slug" });
  });
});

describe("wipeGuard", () => {
  it("blocks when the backend is empty but Framer holds items", () => {
    expect(wipeGuard(0, 308, 0.2).ok).toBe(false);
  });

  it("blocks when removals exceed the allowed share", () => {
    expect(wipeGuard(200, 308, 0.2).ok).toBe(false);
  });

  it("allows a normal incremental sync", () => {
    expect(wipeGuard(310, 308, 0.2).ok).toBe(true);
  });

  it("allows the first sync into an empty collection", () => {
    expect(wipeGuard(308, 0, 0.2).ok).toBe(true);
  });

  it("explains why it blocked so the alert is actionable", () => {
    expect(wipeGuard(0, 308, 0.2).reason).toMatch(/backend/i);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run src/services/framer-sync.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

Create `src/services/framer-sync.ts`. Port `buildItems` from `plugin/src/components/SyncHandler.tsx:27-72` (it is currently untested — this is the first test coverage it gets). Add:

```typescript
/**
 * Refuse to sync when the removal set looks like data loss rather than an edit.
 *
 * The sync computes "remove everything in Framer that is absent from the
 * backend". An empty or half-loaded database therefore deletes the entire live
 * blog in one call. At 300+ articles that is unrecoverable without a restore.
 */
export function wipeGuard(
  backendCount: number,
  framerCount: number,
  maxRemovalShare: number
): { ok: true } | { ok: false; reason: string } {
  if (framerCount === 0) return { ok: true };
  if (backendCount === 0) {
    return { ok: false, reason: `backend reports 0 published articles while Framer holds ${framerCount} — refusing to sync` };
  }
  const removals = Math.max(0, framerCount - backendCount);
  if (removals / framerCount > maxRemovalShare) {
    return { ok: false, reason: `sync would remove ${removals}/${framerCount} items (> ${maxRemovalShare * 100}%) — refusing` };
  }
  return { ok: true };
}
```

Add the **binding guard**, which is specific to the bug found during migration:

```typescript
/**
 * Framer resolves relative hrefs (<a href="/blog/slug">) to CMS item references
 * at INGEST time. Writing into a collection that is not bound to the article CMS
 * page silently strips every internal link — and the Server API serializes a
 * resolved and an unresolved link identically, so this is undetectable after the
 * fact. Refuse to sync unless the target collection id matches the configured
 * bound collection.
 */
export function assertBoundCollection(targetId: string, configuredId: string): void {
  if (targetId !== configuredId) {
    throw new Error(
      `refusing to sync: collection ${targetId} is not the configured bound collection ${configuredId}. ` +
        `Syncing into an unbound collection destroys all internal links.`
    );
  }
}
```

The sync entrypoint:

```typescript
export async function syncToFramer(): Promise<{ synced: number; removed: number }> {
  // connect → getManagedCollections → find by settings.framerCollectionId
  // → assertBoundCollection → getLocales → build locale map
  // → setFields (append-only: pass existing fields back with identical ids)
  // → wipeGuard → addItems (chunks of 20; the payload is ~10 MB)
  // → removeItems → setPluginData("lastSync", ISO timestamp)
  // Always disconnect in a finally block.
}
```

**Step 4: Run and verify green**

Run: `npx vitest run src/services/framer-sync.test.ts`
Expected: 8 passed.

**Step 5: Commit**

```bash
git add src/services/framer-sync.ts src/services/framer-sync.test.ts
git commit -m "feat: add Framer Server API sync with wipe and binding guards"
```

---

## Task 11: Debounced publish

**Files:**
- Create: `src/services/publish-debounce.ts`
- Test: `src/services/publish-debounce.test.ts`

Approving 10 articles must produce **one** site deploy, not ten. Use `vi.useFakeTimers()`.

Tests:
- a single approval schedules one publish after the delay
- ten approvals inside the window still produce exactly one publish
- a new approval resets the timer
- a publish failure retries once, then alerts
- `flushNow()` publishes immediately (for a manual trigger)

```bash
git commit -m "feat: debounce Framer publish into one deploy per review session"
```

---

## Task 12: Scheduler

**Files:**
- Create: `src/services/scheduler.ts`
- Test: `src/services/scheduler.test.ts`
- Modify: `src/index.ts` (start it)

**Behaviour:**
1. Fires nightly at the configured hour (default 20:00, `settings.scheduleHour`).
2. **Single-flight lock** — an overrunning night must not collide with the next tick.
3. `last_run_date` in settings — if the process was down at the scheduled hour, run on next boot rather than skipping a day.
4. `SCHEDULER_DRY_RUN=1` → run selection and title proposal, send the digest, generate nothing.
5. Nightly cap independent of the HTTP rate limiter in `routes/generate.ts` (which is in-memory, per-hour, and would otherwise clamp the batch at 10).

Tests (pure, with an injected clock):
- `shouldRun(now, lastRunDate, hour)` → true at/after the hour on a new date
- → false when already run today
- → true when the last run was two days ago (missed run recovery)
- the single-flight lock rejects a second concurrent invocation
- dry-run mode calls the title proposer but never the generator

```bash
git commit -m "feat: add nightly scheduler with single-flight and missed-run recovery"
```

---

## Task 13: Wire the pipeline together

**Files:**
- Create: `src/services/autopilot.ts`
- Modify: `src/index.ts`

`runNightly()`:
1. Load niches + cursor from settings.
2. `needsTopUp(pending, threshold)` → `nextSlot()` → `seedTopics(persona+subniche, angle, kbHints, getCoveredTopics())` → persist the advanced cursor.
3. `selectTopics(pending, randomBetween(5, 10))`.
4. `proposeTitle()` per topic; store `proposed_title` on the keyword.
5. Send the gate-1 digest; store `bot_message_id`.

`onTitleApproved(keywordId)` → set keyword `approved`, `enqueueGeneration({ keywordId, query, titleOverride })`.

`onArticleReady(articleId)` → send the gate-2 digest with the `.html` attachment.

`onPublishApproved(articleId)` → `POST /api/articles/:id/publish` logic → `syncToFramer()` → arm the debounce.

**Test:** `src/services/autopilot.test.ts` with every dependency injected — asserts the ordering (top-up before selection, titles before digest) and that a dry run stops after the digest.

```bash
git commit -m "feat: wire the nightly autopilot pipeline"
```

---

## Task 14: Plugin settings UI

**Files:**
- Modify: `plugin/src/components/Settings.tsx`
- Modify: `plugin/src/api/client.ts`
- Create: `src/routes/settings.ts`

A Generator section: edit the 8 niches (persona, subniches, kb_hints, probation), articles-per-night range, schedule hour, and an "expand subniches" button calling a one-shot Claude expansion. `GET/POST /api/settings` behind `authMiddleware`.

```bash
git commit -m "feat: add generator settings UI to the plugin"
```

---

## Task 15: Cleanups found during the migration investigation

**Files:**
- Modify: `src/routes/articles.ts`
- Modify: `src/services/generator.ts`

**Step 1: Unshadow the translate-status route**

`GET /api/articles/:id` is registered at line 64, before `GET /api/articles/translate-status` at line 345 — so Hono matches the literal path as an article ID and the endpoint always returns "Article not found". The plugin's `getTranslationStatus()` polling has never worked.

Move the literal routes (`/translate-status`, `/translate-batch`, `/translate-all`) **above** `articles.get("/:id", ...)`.

**Step 2: Write a regression test**

Assert `GET /api/articles/translate-status` returns a queue-status shape, not a 404.

**Step 3: Add a placeholder guard**

6 of 308 articles contain a literal `"placeholder"` text node (5 as a trailing node). No code emits it — it is model output that survived sanitisation. Add a check in the generator's sanitiser that strips a bare trailing `placeholder` text node, and flag the article so it surfaces at gate 2.

**Step 4: Clean the 6 affected articles**

One-off script against the production API; re-sync afterwards.

```bash
git commit -m "fix: unshadow translate-status route and strip stray placeholder text"
```

---

## Deployment checklist

Railway → Variables:

```
FRAMER_API_KEY=<rotate the one used during migration>
FRAMER_PROJECT_URL=https://framer.com/projects/CRMChat-New--obDYpxrpLqjA1CG4lfvg
FRAMER_COLLECTION_ID=kqBHLapEf
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=<your chat id>
TELEGRAM_WEBHOOK_SECRET=<random string>
SCHEDULER_DRY_RUN=1          # remove after the first clean dry run
```

Then:
1. Deploy; confirm `/api/status` responds.
2. Register the webhook: `POST https://api.telegram.org/bot<token>/setWebhook` with `url` and `secret_token`.
3. Watch one dry run end-to-end — digest arrives, nothing generates.
4. Set `SCHEDULER_DRY_RUN=0`, cap at **1-2 articles/night for a week**, with the three new niches on probation.
5. Scale to 5-10/night once a week of output looks right.

## Do not break these

- **Item IDs and slugs are identity.** Changing either orphans the Framer item and breaks live URLs.
- **`setFields` is append-only.** Pass existing fields back with identical IDs or canvas bindings break.
- **Never sync into an unbound collection.** It silently destroys every internal link and nothing reports an error.
- **Era rows stay excluded.** They duplicated already-published articles.
- **A cold Framer URL returns a shell on first request.** Request twice before concluding a page is missing.
