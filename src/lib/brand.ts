/**
 * The brand is written "crmchat", all lowercase, wherever it reaches the site —
 * titles, summaries, bodies, schema, every locale. The prompts ask for it, but
 * the knowledge base and older articles still say "CRMChat", and the model
 * copies what it reads, so the casing is enforced here rather than trusted.
 */
export const BRAND = "crmchat";

/**
 * Rewrite any casing of the brand ("CRMChat", "CRMchat", "CrmChat") to
 * "crmchat". Whole word only, so the domain and handles such as
 * "@crmchatcontactbot" are left as they are (and are lowercase already).
 */
export function normalizeBrand(text: string): string {
  return text.replace(/\bcrmchat\b/gi, BRAND);
}
