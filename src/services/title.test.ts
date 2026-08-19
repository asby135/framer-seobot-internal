import { describe, it, expect, vi } from "vitest";
import { proposeTitle, type TitleClient } from "./title.js";

/** A stub client that returns queued titles in order. */
const stub = (titles: string[]): TitleClient & { calls: unknown[] } => {
  let i = 0;
  const calls: unknown[] = [];
  return {
    calls,
    async propose(req) {
      calls.push(req);
      return titles[i++] ?? "Fallback Title";
    },
  };
};

describe("proposeTitle", () => {
  it("returns the model's title when it is clean", async () => {
    const c = stub(["Your Sales Team Runs on Telegram"]);
    expect(await proposeTitle("topic", [], [], c)).toBe("Your Sales Team Runs on Telegram");
    expect(c.calls).toHaveLength(1);
  });

  it("trims surrounding whitespace", async () => {
    const c = stub(["  Spaced Out Headline  "]);
    expect(await proposeTitle("topic", [], [], c)).toBe("Spaced Out Headline");
  });

  it("retries once when the title contains a banned tic", async () => {
    const c = stub(["The Ultimate Guide to Telegram", "Telegram CRM Without the Guesswork"]);
    expect(await proposeTitle("topic", [], [], c)).toBe("Telegram CRM Without the Guesswork");
    expect(c.calls).toHaveLength(2);
  });

  it("feeds the rejected title back so the retry does not repeat it", async () => {
    const c = stub(["The Ultimate Guide", "Clean Headline"]);
    await proposeTitle("topic", [], [], c);
    const second = c.calls[1] as { rejected: string[] };
    expect(second.rejected).toContain("The Ultimate Guide");
  });

  it("gives up after one retry rather than looping", async () => {
    // The operator sees the title at gate 1 and can reroll — an unbounded
    // retry loop would burn tokens on a model that keeps producing tics.
    const c = stub(["Ultimate Guide", "Complete Guide"]);
    expect(await proposeTitle("topic", [], [], c)).toBe("Complete Guide");
    expect(c.calls).toHaveLength(2);
  });

  it("passes recent titles through for shape variety", async () => {
    const c = stub(["Fresh Title"]);
    await proposeTitle("topic", ["Recent One"], [], c);
    expect(c.calls[0]).toMatchObject({ recentTitles: ["Recent One"] });
  });

  it("passes pre-existing rejections through on a reroll", async () => {
    const c = stub(["Fresh Title"]);
    await proposeTitle("topic", [], ["Rejected One"], c);
    expect(c.calls[0]).toMatchObject({ rejected: ["Rejected One"] });
  });

  it("passes the topic through", async () => {
    const c = stub(["Fresh Title"]);
    await proposeTitle("my topic phrase", [], [], c);
    expect(c.calls[0]).toMatchObject({ topic: "my topic phrase" });
  });

  it("propagates a client error rather than returning an empty title", async () => {
    const boom: TitleClient = { propose: vi.fn(async () => { throw new Error("api down"); }) };
    await expect(proposeTitle("topic", [], [], boom)).rejects.toThrow("api down");
  });
});
