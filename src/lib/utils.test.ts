import { describe, it, expect } from "vitest";
import { uniqueSlug } from "./utils.js";

describe("uniqueSlug", () => {
  it("keeps a free slug as it is", () => {
    expect(uniqueSlug("telegram-crm", new Set())).toBe("telegram-crm");
  });

  it("numbers a taken slug instead of appending random characters", () => {
    // The old suffix was nanoid(6): URLs like /blog/telegram-crm-Zz_ysK.
    expect(uniqueSlug("telegram-crm", new Set(["telegram-crm"]))).toBe("telegram-crm-2");
    expect(uniqueSlug("telegram-crm", new Set(["telegram-crm", "telegram-crm-2"]))).toBe("telegram-crm-3");
  });
});
