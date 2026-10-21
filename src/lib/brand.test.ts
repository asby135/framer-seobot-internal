import { describe, it, expect } from "vitest";
import { normalizeBrand } from "./brand.js";

describe("normalizeBrand", () => {
  it.each([
    ["CRMChat includes Channel Sync.", "crmchat includes Channel Sync."],
    ["Try CRMchat today", "Try crmchat today"],
    ["CrmChat's API", "crmchat's API"],
    ["<a href=\"https://crmchat.ai/\">CRMChat</a>", "<a href=\"https://crmchat.ai/\">crmchat</a>"],
    ["Kommo vs CRMChat", "Kommo vs crmchat"],
  ])("lowercases the brand: %s", (input, expected) => {
    expect(normalizeBrand(input)).toBe(expected);
  });

  it("leaves URLs, bot handles and unrelated words alone", () => {
    const text = "See https://developers.crmchat.ai/ or @crmchatcontactbot; a CRM chat view.";
    expect(normalizeBrand(text)).toBe(text);
  });
});
