/**
 * Convert a search query to a URL-friendly slug.
 * Used to check if an article already covers this topic.
 */
export function queryToSlug(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * `base`, or `base-2`, `base-3`… — the first one not in `taken`.
 *
 * Replaces a random nanoid(6) suffix, which produced URLs like
 * /blog/telegram-crm-Zz_ysK: mixed case and underscores in a public path.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
