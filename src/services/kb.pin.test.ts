import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadKB, searchKB } from "./kb.js";

const kbDir = join(dirname(fileURLToPath(import.meta.url)), "../../knowledge");
const PIN = "finding-decision-makers-ru-cis.md";

beforeAll(() => {
  loadKB(kbDir);
});

describe("searchKB retrieval pin (decision-makers workflow)", () => {
  const decisionMakerQueries = [
    "how to find decision makers on telegram",
    "building a b2b prospect list in russia and cis",
    "finding company founders telegram contacts",
    "how to build a telegram prospect database", // missed even at raw top-5
    "find business owners telegram outreach russia",
  ];

  it.each(decisionMakerQueries)(
    "pins the decision-makers doc into the top-3 for: %s",
    (q) => {
      const files = searchKB(q, 3).map((a) => a.filename);
      expect(files).toContain(PIN);
      // Pinned doc is placed first.
      expect(files[0]).toBe(PIN);
    }
  );

  it("does NOT trigger on a substring like 'decision' inside unrelated words", () => {
    // 'cis' is a trigger; 'decision' contains 'cis' but must not match.
    const files = searchKB("telegram automation basics and precision", 3).map(
      (a) => a.filename
    );
    // No decision-maker keyword present → pin should not force-include the doc
    // (it may still appear on genuine TF-IDF merit, but must not be forced to rank 1).
    expect(files[0]).not.toBe(PIN);
  });

  it("leaves unrelated queries to pure TF-IDF (no pin)", () => {
    const files = searchKB("how to warm up a new telegram account", 3).map(
      (a) => a.filename
    );
    expect(files).not.toContain(PIN);
  });
});
