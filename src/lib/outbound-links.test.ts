import { describe, it, expect } from "vitest";
import { isAllowedOutboundUrl, unwrapDisallowedLinks, disallowedLinkHosts } from "./outbound-links.js";

describe("isAllowedOutboundUrl", () => {
  it("allows crmchat, Telegram's docs, public bodies and research", () => {
    for (const u of [
      "https://crmchat.ai/content-creators",
      "https://core.telegram.org/bots/api",
      "https://telegram.org/tos",
      "https://www.irs.gov/forms",
      "https://www.gov.uk/guidance",
      "https://www.esma.europa.eu/x",
      "https://en.wikipedia.org/wiki/X",
      "https://t.me/crmchatppvbot",
    ]) expect(isAllowedOutboundUrl(u), u).toBe(true);
  });

  it("refuses competitors and other vendors", () => {
    for (const u of [
      "https://onlymonster.ai/faq",
      "https://www.infloww.com/pricing",
      "https://help.supercreator.app/en/articles/1",
      "https://www.hubspot.com/",
      "https://github.com/x/y",
      "https://t.me/someoneelsesbot",
      "https://notgov.com/",
    ]) expect(isAllowedOutboundUrl(u), u).toBe(false);
  });

  it("leaves relative links and mail links alone", () => {
    expect(isAllowedOutboundUrl("/blog/what-is-chatter-onlyfans-agency")).toBe(true);
    expect(isAllowedOutboundUrl("./hire-first-chatter")).toBe(true);
    expect(isAllowedOutboundUrl("mailto:hi@crmchat.ai")).toBe(true);
  });
});

describe("unwrapDisallowedLinks", () => {
  it("keeps the anchor text and drops the link to a vendor", () => {
    expect(unwrapDisallowedLinks('<p>Per <a href="https://onlymonster.ai/faq">its FAQ</a>, $30.</p>')).toBe(
      "<p>Per its FAQ, $30.</p>"
    );
  });

  it("keeps internal links, crmchat and Telegram docs", () => {
    const html =
      '<p><a href="/blog/x">a</a> <a href="https://crmchat.ai/">b</a> <a href="https://core.telegram.org/bots/api">c</a></p>';
    expect(unwrapDisallowedLinks(html)).toBe(html);
  });

  it("handles inline markup inside the anchor and several links", () => {
    expect(
      unwrapDisallowedLinks('<td><a href="https://infloww.com"><strong>Infloww</strong></a> and <a href="https://fansmetric.com/pricing">$39</a></td>')
    ).toBe("<td><strong>Infloww</strong> and $39</td>");
  });

  it("reports the hosts it would remove", () => {
    expect(disallowedLinkHosts('<a href="https://www.infloww.com/pricing">x</a><a href="/blog/y">y</a>')).toEqual(["infloww.com"]);
  });
});
