import Anthropic from "@anthropic-ai/sdk";
import { findTitleTics } from "./generator.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * Headline proposal for the pre-generation approval gate.
 *
 * The article generator normally writes the title and body together. To let the
 * operator approve a headline BEFORE spending a full generation, this proposes
 * one from the topic alone; the approved title is then pinned into generation
 * (see buildTitleInstruction in generator.ts).
 */

export interface TitleRequest {
  topic: string;
  /** Recent published titles, so the proposal does not echo their shape. */
  recentTitles: string[];
  /** Titles already rejected — by the tic check, or by the operator rerolling. */
  rejected: string[];
}

export interface TitleClient {
  propose(req: TitleRequest): Promise<string>;
}

/** Words too common to count as keyword overlap. */
const STOPWORDS = new Set([
  "how", "the", "and", "for", "with", "your", "you", "that", "this", "from",
  "into", "before", "after", "when", "what", "why", "not", "but", "are", "was",
  "its", "their", "them", "they", "have", "has", "had", "can", "will", "just",
  "who", "which", "then", "than", "over", "out", "off", "way", "get", "got",
]);

/**
 * Substantive words in a phrase — the ones that carry the keyword.
 * Short words and stopwords are dropped so "how to" and "before a" cannot
 * masquerade as overlap.
 */
export function contentWords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/**
 * Does the headline still carry its keyword?
 *
 * TITLE CRAFT rule 1 is two-sided: "the target keyword MUST appear (Google
 * still ranks on it), BUT reframe it". proposeTitle originally shipped only the
 * reframe half, and titles drifted until the topic was unrecognisable — "How to
 * research startup founders before a VC intro call" became "You Get 15 Minutes
 * With a Founder", which shares nothing a searcher would type.
 *
 * Two content words is the bar: one is coincidence ("founders" appears in half
 * the corpus), two means the headline is about the same thing. A topic with
 * only one content word is satisfied by that word alone.
 */
export function sharesKeyword(title: string, topic: string): boolean {
  const topicWords = contentWords(topic);
  if (topicWords.length === 0) return true;

  const titleWords = new Set(contentWords(title));
  const overlap = topicWords.filter((w) => titleWords.has(w)).length;

  return overlap >= Math.min(2, topicWords.length);
}

const MAX_ATTEMPTS = 2;

/**
 * Propose a headline, validating it against the same ban-list the generator
 * uses so a proposed title cannot be worse than a generated one.
 *
 * Retries once on a banned tic, then returns whatever came back rather than
 * looping: the operator sees the title at gate 1 and can reroll or reject, so
 * an unbounded retry would burn tokens to avoid a decision a human is about to
 * make anyway.
 */
export async function proposeTitle(
  topic: string,
  recentTitles: string[],
  rejected: string[],
  client: TitleClient = defaultClient()
): Promise<string> {
  let excluded = [...rejected];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const title = (await client.propose({ topic, recentTitles, rejected: excluded })).trim();
    const tics = findTitleTics(title);
    const keptKeyword = sharesKeyword(title, topic);

    if (tics.length === 0 && keptKeyword) return title;

    logger.warn(
      { title, topic, tics, keptKeyword, attempt },
      keptKeyword ? "Proposed title contains banned tics" : "Proposed title lost its keyword"
    );
    if (attempt === MAX_ATTEMPTS) return title;

    excluded = [...excluded, title];
  }

  /* c8 ignore next */
  throw new Error("unreachable");
}

function defaultClient(): TitleClient {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  return {
    async propose({ topic, recentTitles, rejected }) {
      const res = await anthropic.messages.create({
        model: "claude-sonnet-5",
        // Match the seeder/generator: disable adaptive thinking for a short,
        // deterministic single-output call.
        thinking: { type: "disabled" },
        max_tokens: 256,
        system: `You write article headlines for CRMChat, a Telegram-native CRM and outreach platform for sales teams.

TITLE CRAFT:
- The title is the only thing most people read. Treat it as copywriting, not a label for the article.
- THE KEYWORD MUST APPEAR. Search engines still rank on it, and an answer engine matches the question to the headline. Carry the topic's substantive words into the title — then reframe AROUND them. Rearrange, drop filler, add a hook, lead with the pain. Do not copy the topic phrase verbatim, and do not drift so far that a searcher could not tell the title answers their query.
  TOPIC: "Vtiger CRM Telegram integration setup guide"
  BAD (copy-paste): "Vtiger CRM Telegram Integration: Step-by-Step Setup Guide"
  BAD (keyword gone): "Connect Everything Without Breaking Your Pipeline"
  GOOD (reframed, keyword intact): "Connect Vtiger to Telegram Without Breaking Your Pipeline"
- Lead with the reader's problem or a concrete specific, not with the product.
- HARD BAN — the title MUST NOT contain any of: 'Actually', 'Really', 'Ultimate', 'Complete Guide', 'Everything You Need', 'A Deep Dive', 'No-Fluff', 'No-Agency', 'The Truth About', parenthetical subtitles like '(Step-by-Step)' or '(And Where Each Falls Short)', or year suffixes like 'in 2026'. These are AI-content tells that destroy citation credibility.
- Vary the shape: do not reuse the opening word, the hook word, or the colon-subtitle shape of the recent titles listed below.

Reply with the headline only. No quotes, no preamble, no explanation.`,
        messages: [
          {
            role: "user",
            content: `TOPIC: ${topic}
${recentTitles.length > 0 ? `\nRECENT TITLES — do not echo their shape or opening word:\n${recentTitles.map((t) => `- ${t}`).join("\n")}` : ""}
${rejected.length > 0 ? `\nREJECTED — do not propose these or close variants:\n${rejected.map((t) => `- ${t}`).join("\n")}` : ""}`,
          },
        ],
      });

      const block = res.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        logger.error({ stopReason: res.stop_reason }, "Title proposal returned no text block");
        return "";
      }
      return block.text;
    },
  };
}
