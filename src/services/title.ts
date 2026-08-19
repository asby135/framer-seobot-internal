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

    if (tics.length === 0) return title;

    logger.warn({ title, tics, attempt }, "Proposed title contains banned tics");
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
- Reframe the topic into a reader-facing headline — do NOT copy the topic phrase back.
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
