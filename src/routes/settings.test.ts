import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { __setTestDb } from "../services/settings.js";
import { settings } from "./settings.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
           updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  __setTestDb(db);
});

const get = () => settings.request("/");
const put = (body: unknown) =>
  settings.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const niche = (over: Record<string, unknown> = {}) => ({
  name: "Web3",
  persona: "Web3 BD leads running partnership outreach on Telegram",
  subniches: ["DeFi protocols"],
  kb_hints: [],
  probation: false,
  ...over,
});

describe("GET /api/settings", () => {
  it("returns defaults when nothing is stored", async () => {
    const body = (await (await get()).json()) as Record<string, unknown>;
    expect(body.niches).toBeInstanceOf(Array);
    expect((body.niches as unknown[]).length).toBe(8);
    expect(body.minPerNight).toBe(5);
    expect(body.maxPerNight).toBe(10);
    expect(body.scheduleHour).toBe(20);
  });

  it("exposes exactly the tuning keys and nothing else", async () => {
    // An allowlist rather than a substring scan: content legitimately contains
    // words like "token launchpads", so scanning the body for /token|secret/
    // false-positives. What actually matters is that no NEW key can appear
    // here without this test failing — which is what would leak a credential.
    const body = (await (await get()).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "lastRunDate",
        "maxPerNight",
        "minPerNight",
        "niches",
        "poolThreshold",
        "rotationCursor",
        "scheduleHour",
      ].sort()
    );
  });
});

describe("POST /api/settings", () => {
  it("persists niches", async () => {
    const res = await put({ niches: [niche()] });
    expect(res.status).toBe(200);
    const body = (await (await get()).json()) as { niches: unknown[] };
    expect(body.niches).toHaveLength(1);
  });

  it("persists the nightly range", async () => {
    await put({ minPerNight: 2, maxPerNight: 3 });
    const body = (await (await get()).json()) as Record<string, number>;
    expect(body.minPerNight).toBe(2);
    expect(body.maxPerNight).toBe(3);
  });

  it("rejects a max below the min", async () => {
    const res = await put({ minPerNight: 8, maxPerNight: 3 });
    expect(res.status).toBe(400);
  });

  it("rejects a nightly count over the hard cap", async () => {
    // An unbounded value would let one edit spend the month's budget overnight.
    const res = await put({ minPerNight: 1, maxPerNight: 500 });
    expect(res.status).toBe(400);
  });

  it("rejects a schedule hour outside 0-23", async () => {
    expect((await put({ scheduleHour: 24 })).status).toBe(400);
    expect((await put({ scheduleHour: -1 })).status).toBe(400);
  });

  it("rejects a niche with no persona", async () => {
    const res = await put({ niches: [niche({ persona: "" })] });
    expect(res.status).toBe(400);
  });

  it("rejects a persona that is a bare label rather than a sentence", async () => {
    // seedTopics grounds on searchKB(persona); a one-word label retrieves noise.
    const res = await put({ niches: [niche({ persona: "Web3" })] });
    expect(res.status).toBe(400);
  });

  it("rejects a niche with no subniches", async () => {
    const res = await put({ niches: [niche({ subniches: [] })] });
    expect(res.status).toBe(400);
  });

  it("rejects a non-array niches value", async () => {
    expect((await put({ niches: "all of them" })).status).toBe(400);
  });

  it("leaves unspecified keys untouched", async () => {
    await put({ minPerNight: 3, maxPerNight: 4 });
    await put({ scheduleHour: 21 });
    const body = (await (await get()).json()) as Record<string, number>;
    expect(body.minPerNight).toBe(3);
    expect(body.scheduleHour).toBe(21);
  });

  it("reports which keys it wrote", async () => {
    const body = (await (await put({ scheduleHour: 21 })).json()) as { updated: string[] };
    expect(body.updated).toEqual(["scheduleHour"]);
  });
});
