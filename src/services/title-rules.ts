/**
 * The house style for article titles — one definition, used everywhere a title
 * is written.
 *
 * This exists because it was duplicated once and drifted. The generator's
 * TITLE CRAFT block said "the target keyword MUST appear, BUT reframe it";
 * proposeTitle copied the second half and dropped the first, and titles drifted
 * until "How to research startup founders before a VC intro call" became
 * "You Get 15 Minutes With a Founder". Any prompt that produces a title imports
 * from here.
 *
 * The style itself is long-tail task SEO, modelled on libraries like
 * ninjaone.com/blog: the title IS the search query, stated plainly. That is the
 * opposite of magazine copywriting, and deliberately so — a reader searching
 * for a task must recognise the headline as answering it, and an answer engine
 * matches the question to the title.
 */

/** Phrasings that read as AI-generated and cost citation credibility. */
export const BANNED_TITLE_PHRASES = [
  "Actually",
  "Really",
  "Ultimate",
  "Complete Guide",
  "Everything You Need",
  "A Deep Dive",
  "No-Fluff",
  "No-Agency",
  "The Truth About",
] as const;

/** Title shape per article archetype. Keys match ANGLE_WEIGHTS in taxonomy.ts. */
export const TITLE_SHAPE_BY_ANGLE: Record<string, string> = {
  "how-to": '"How to <do the specific task>" — state the task, not a benefit',
  "what-is": '"What Is <term>" or "<term>, Explained" — name the thing being defined',
  troubleshooting: '"<Thing> Not Working" / "Why <thing> <fails>" / "Fix <specific error>"',
  comparison: '"<A> vs <B>" or "<N> <category> Alternatives"',
  tops: '"Best <category> for <audience>" or "<N> <category> Tools"',
};

/**
 * The shared rule block. Injected verbatim into every title-writing prompt.
 *
 * Deliberately plain-spoken about formula: for long-tail search, a predictable
 * title is a feature. The reader is not browsing, they are looking for one
 * specific answer, and a clever headline makes it HARDER to recognise.
 */
export const TITLE_RULES = `TITLE RULES:
- The title IS the search query, written plainly. Someone with this exact problem must recognise the title as answering it at a glance.
- Do NOT write a clever, curiosity-gap, or magazine-style headline. No hooks, no provocations, no "Here's why", no rhetorical questions, no invented statistics. A predictable title is correct here: the reader is not browsing, they are looking for one specific answer.
- Keep every substantive word of the task in the title. Dropping them to sound punchier is the failure mode this rule exists to prevent.
- Match the shape to the article type (given below).
- Sentence-case or Title Case, no trailing punctuation, roughly 6-12 words.
- NEVER include: ${BANNED_TITLE_PHRASES.join(", ")}, parenthetical subtitles like "(Step-by-Step)", or year suffixes like "in 2026".
- Do not name the product in the title. The article earns its mention in the body, not the headline.

GOOD (plain, task-shaped, product-free):
  "How to Export Telegram Group Members to CSV"
  "Why Telegram Accounts Get Banned for Bulk Messaging"
  "What Is a Telegram Session String"
BAD (clever, product-led, or vague):
  "Your Group Members Are Trapped and You Do not Know It"   (curiosity gap, no keyword)
  "Export Members Fast With CRMChat"                        (product in the title)
  "The Ultimate Guide to Telegram Exports"                  (banned phrasing)`;
