import { describe, it, expect } from "vitest";
import { namesCompetitor, isPureCompetitorTopic } from "./competitors.js";

describe("namesCompetitor", () => {
  it("matches case-insensitively", () => {
    expect(namesCompetitor("Migrating from VTIGER")).toBe(true);
  });

  it("is false for topics naming nobody", () => {
    expect(namesCompetitor("How to export a Telegram group")).toBe(false);
  });
});

describe("isPureCompetitorTopic", () => {
  it("skips a competitor topic with no task angle", () => {
    // Pure brand SEO for someone else — no realistic CRMChat hook.
    expect(isPureCompetitorTopic("Vtiger CRM review")).toBe(true);
  });

  it("keeps a competitor topic that carries a task angle", () => {
    expect(isPureCompetitorTopic("Vtiger Telegram integration setup guide")).toBe(false);
  });

  it("keeps anything naming CRMChat, even a bare comparison", () => {
    expect(isPureCompetitorTopic("Vtiger vs CRMChat")).toBe(false);
  });

  it("keeps generic topics that name no competitor", () => {
    // The seeder's adjacent-task titles land here — they must survive the filter.
    expect(isPureCompetitorTopic("How to Export Telegram Group Members to CSV")).toBe(false);
  });
});
