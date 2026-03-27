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
