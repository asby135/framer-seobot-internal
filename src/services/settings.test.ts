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

  it("preserves falsy values rather than treating them as absent", () => {
    setSetting("zero", 0);
    setSetting("flag", false);
    expect(getSetting("zero", 99)).toBe(0);
    expect(getSetting("flag", true)).toBe(false);
  });
});
