import { logger } from "../lib/logger.js";

/**
 * External links that are dead before the article ships.
 *
 * Only a definite "gone" counts: 404, 410, or a host that does not resolve.
 * 401/403/429 and timeouts are what bot protection returns for pages that work
 * in a browser (Carta, Koinly, Coinbase all answer 403 to a script), so they
 * are not reported.
 */
export interface BrokenLink {
  url: string;
  status: number | "unreachable";
}

const TIMEOUT_MS = 10_000;
const CONCURRENCY = 5;
const UA = "Mozilla/5.0 (compatible; crmchat-link-check/1.0)";

export function externalLinks(html: string): string[] {
  const urls = [...html.matchAll(/<a\s[^>]*href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  return [...new Set(urls)];
}

async function probe(url: string, fetchImpl: typeof fetch): Promise<BrokenLink | null> {
  const attempt = async (method: "HEAD" | "GET") =>
    fetchImpl(url, { method, redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  try {
    let res = await attempt("HEAD");
    // Plenty of servers do not implement HEAD; ask again properly.
    if (res.status === 405 || res.status === 501) res = await attempt("GET");
    return res.status === 404 || res.status === 410 ? { url, status: res.status } : null;
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    // DNS failure means the site is gone; a timeout or reset proves nothing.
    return cause === "ENOTFOUND" ? { url, status: "unreachable" } : null;
  }
}

export async function findBrokenLinks(html: string, fetchImpl: typeof fetch = fetch): Promise<BrokenLink[]> {
  const urls = externalLinks(html);
  const broken: BrokenLink[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = await Promise.all(urls.slice(i, i + CONCURRENCY).map((u) => probe(u, fetchImpl)));
    for (const b of batch) if (b) broken.push(b);
  }
  if (broken.length) logger.warn({ broken }, "Broken external links");
  return broken;
}
