/**
 * Competitor brand names and the "is this topic worth writing" filter that
 * depends on them — shared by topic seeding (seeder.ts) and article generation
 * (generator.ts).
 *
 * This is the single source of truth: seeder.ts uses it to drop pure-competitor
 * topics, generator.ts uses it to decide whether an article needs a web-search
 * research pass for accurate, current competitor facts.
 */
export const COMPETITORS = [
  "nreach",
  "enreach",
  "entergram",
  "vtiger",
  "hubspot",
  "zoho",
  "salesforce",
];

/**
 * True if the query mentions any competitor brand name (case-insensitive).
 */
export function namesCompetitor(query: string): boolean {
  const q = query.toLowerCase();
  return COMPETITORS.some((c) => q.includes(c));
}

// Task/integration signals. If a competitor-named topic also contains one of
// these, it's a how-to / pain-point topic (e.g. "Vtiger Telegram integration
// setup guide") where CRMChat's Telegram-native nature is a genuine reframe —
// keep it. NOTE: "telegram" and "bot" are intentionally excluded — nearly every
// query in this dataset contains them, so they're useless as a distinguishing
// signal.
const TASK_SIGNALS = [
  "integration",
  "integrate",
  "setup",
  "set up",
  "connect",
  "sync",
  "automate",
  "automation",
  "how to",
  "guide",
  "tutorial",
  "api",
  "webhook",
];

/**
 * A "pure competitor" topic names a competitor, does not mention CRMChat, and
 * has no task/integration angle. Writing these is SEO work for the competitor's
 * brand with no realistic CRMChat hook — skip them.
 *
 * Kept (returns false):
 *  - anything mentioning "crmchat" (comparison / migration / brand topic)
 *  - competitor topics with a task signal ("Vtiger Telegram integration guide")
 *  - generic / category topics that name no competitor at all
 */
export function isPureCompetitorTopic(query: string): boolean {
  const q = query.toLowerCase();
  if (q.includes("crmchat")) return false; // comparison / migration / brand — keep
  if (!namesCompetitor(query)) return false; // generic / category — keep
  const hasTaskAngle = TASK_SIGNALS.some((s) => q.includes(s));
  return !hasTaskAngle; // competitor named, no task angle, no CRMChat — skip
}
