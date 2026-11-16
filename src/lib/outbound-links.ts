/**
 * Which external sites an article may link to.
 *
 * Every link to another company's product site, pricing page, blog or help
 * center is a backlink for them. The first creator-agency batch (Nov 2026)
 * carried 103 links to competitors such as OnlyMonster and Infloww, and the
 * wider blog linked to some 130 other vendors from tool roundups. The operator
 * decided the blog names other products in plain text and links only to
 * crmchat and to neutral primary sources.
 *
 * An allowlist, so a vendor nobody listed is unlinked by default.
 */

/** Hosts (and their subdomains) that may be linked. */
const ALLOWED_HOSTS = [
  "crmchat.ai",
  // Telegram's own documentation and policies: primary sources, not vendors.
  "telegram.org",
  // Regulators and public bodies.
  "europa.eu",
  // Reference and research.
  "wikipedia.org",
  "arxiv.org",
  "doi.org",
];

/** Government and academic domains: .gov, .gov.uk, .gouv.fr, .gob.mx, .edu, .ac.uk … */
const PUBLIC_SUFFIX = /(?:^|\.)(?:gov|gouv|gob|go|govt|mil|edu|ac)(?:\.[a-z]{2})?$/;

/** crmchat's own bots and channels on t.me (e.g. t.me/crmchatppvbot). */
const OWN_TELEGRAM = /^\/crmchat/i;

export function isAllowedOutboundUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return true; // relative or malformed: not an external link
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true; // mailto:, tel:
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (PUBLIC_SUFFIX.test(host)) return true;
  if ((host === "t.me" || host === "telegram.me") && OWN_TELEGRAM.test(url.pathname)) return true;
  return false;
}

/**
 * Replace links to sites that are not allowed with their anchor text.
 *
 * The anchor text stays, so "per <a>Infloww's pricing page</a>" still names the
 * source. Relative links (internal) and allowed hosts are left untouched.
 */
export function unwrapDisallowedLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (match, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
    if (!value || isAllowedOutboundUrl(value.replace(/&amp;/g, "&"))) return match;
    return inner;
  });
}

/** Hosts of the links `unwrapDisallowedLinks` would remove, for reports. */
export function disallowedLinkHosts(html: string): string[] {
  const hosts: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!isAllowedOutboundUrl(href)) {
      try {
        hosts.push(new URL(href).hostname.toLowerCase().replace(/^www\./, ""));
      } catch {
        /* unreachable: disallowed implies parseable */
      }
    }
  }
  return hosts;
}
