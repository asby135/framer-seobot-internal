import { describe, it, expect } from "vitest";
import { externalLinks, findBrokenLinks } from "./link-check.js";

const html = `
<p><a href="https://ok.example/">ok</a> <a href="https://gone.example/x">gone</a>
<a href="https://blocked.example/">blocked</a> <a href="https://nohead.example/">nohead</a>
<a href="https://nxdomain.example/">dead host</a> <a href="/blog/internal">internal</a>
<a href="https://ok.example/">ok again</a></p>`;

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const status = (s: number) => new Response(null, { status: s });
    if (url.startsWith("https://gone.example")) return status(404);
    if (url.startsWith("https://blocked.example")) return status(403);
    if (url.startsWith("https://nohead.example")) return status(init?.method === "HEAD" ? 405 : 200);
    if (url.startsWith("https://nxdomain.example")) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }
    return status(200);
  }) as typeof fetch;
}

describe("link check", () => {
  it("collects unique external links only", () => {
    expect(externalLinks(html)).toHaveLength(5);
  });

  it("reports 404s and dead hosts, not bot blocks or HEAD-less servers", async () => {
    const broken = await findBrokenLinks(html, fakeFetch());
    expect(broken).toEqual([
      { url: "https://gone.example/x", status: 404 },
      { url: "https://nxdomain.example/", status: "unreachable" },
    ]);
  });
});
