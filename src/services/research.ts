import Anthropic from "@anthropic-ai/sdk";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

/**
 * Web research before an article is written: a fact sheet in which every fact
 * carries the URL it was checked on.
 *
 * The hand-written mention-swap listicles (Oct 2026) were good because each
 * tool was looked up on its own site first and the text was then written from
 * those facts. The generator used to research only topics that named a
 * competitor, and got back prose with no sources, so the writer had nothing to
 * link and invented or dropped numbers.
 *
 * Two depths. "full" for listicles, comparisons and topics about other tools:
 * a shortlist of real tools with prices, differences and limitations. "light"
 * for everything else: a few facts about Telegram or the tools the topic names.
 * crmchat itself is left out; the knowledge base covers it.
 *
 * A separate call because the article call forces the publish_article tool and
 * leaves no turn for searching. Non-blocking: on any failure the article is
 * written without the block.
 */

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export type ResearchDepth = "full" | "light";

export interface ResearchFact {
  claim: string;
  source_url: string;
}

export interface ResearchTool {
  name: string;
  url: string;
  job: string;
  difference: string;
  pricing?: string | null;
  pricing_url?: string | null;
  limitation: string;
  telegram?: string | null;
}

export interface ResearchBrief {
  facts: ResearchFact[];
  tools: ResearchTool[];
  unverified: string[];
}

const LIMITS: Record<ResearchDepth, { searches: number; fetches: number }> = {
  full: { searches: 6, fetches: 6 },
  light: { searches: 2, fetches: 2 },
};

/** Server-side web tools resume with pause_turn; two continuations are plenty. */
const MAX_CONTINUATIONS = 2;

/**
 * Wall-clock cap per request. A working pass takes well under a minute; in the
 * first trial two passes ran 11 and 15 minutes and still produced nothing, so
 * a slow pass is cut off and the article is written from the KB instead.
 */
const REQUEST_TIMEOUT_MS = 150_000;

export function researchSystemPrompt(depth: ResearchDepth, today: string): string {
  const task =
    depth === "full"
      ? `Build a shortlist of 6-10 real, currently active tools that answer the topic (or the products a comparison names). For each tool, open its own site and record: homepage url, its job in the reader's workflow, its main difference from the others, its starting price with the pricing page URL (null if the site shows none), one honest limitation, and what the site says about Telegram (null if nothing).`
      : `Find 3-6 facts the article needs that the crmchat knowledge base cannot supply: Telegram limits or features, or facts about tools the topic names. Leave "tools" empty.`;
  return `You research facts for an article on the crmchat blog. crmchat is a Telegram CRM; do not research crmchat itself, its knowledge base covers it. Today is ${today}.

The writer will use your fact sheet as the ONLY source for claims about other products and for every number, and will link each number to the URL you give. So:
- Verify on the primary source: the product's own pricing, feature or docs page (fetch it), an official policy page, or a study or report published in the last 12 months.
- Never use statistics roundups, listicles or other vendors' reviews as a source.
- Leave out vendor self-claims: customer counts, "saves 30%", case-study uplifts.
- If you cannot verify something, put it in "unverified" instead of guessing.

${task}

Finish with ONLY a JSON object in a \`\`\`json fence, shaped:
{"facts":[{"claim":"…","source_url":"https://…"}],"tools":[{"name":"…","url":"https://…","job":"…","difference":"…","pricing":"…","pricing_url":"https://…","limitation":"…","telegram":"…"}],"unverified":["…"]}`;
}

/** The fact sheet from the model's final text, or null when there is none. */
export function parseResearchBrief(text: string): ResearchBrief | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const isUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const facts = (Array.isArray(d.facts) ? d.facts : [])
    .map((f) => f as Record<string, unknown>)
    .filter((f) => str(f.claim) && isUrl(f.source_url))
    .map((f) => ({ claim: str(f.claim)!, source_url: f.source_url as string }));

  const tools = (Array.isArray(d.tools) ? d.tools : [])
    .map((t) => t as Record<string, unknown>)
    .filter((t) => str(t.name) && isUrl(t.url))
    .map((t) => ({
      name: str(t.name)!,
      url: t.url as string,
      job: str(t.job) ?? "",
      difference: str(t.difference) ?? "",
      // A price without the page it came from cannot be linked, so it goes.
      pricing: isUrl(t.pricing_url) ? str(t.pricing) : null,
      pricing_url: isUrl(t.pricing_url) ? (t.pricing_url as string) : null,
      limitation: str(t.limitation) ?? "",
      telegram: str(t.telegram),
    }));

  const unverified = (Array.isArray(d.unverified) ? d.unverified : []).map(str).filter((u): u is string => !!u);

  if (facts.length === 0 && tools.length === 0) return null;
  return { facts, tools, unverified };
}

/** The fact sheet as the block the article prompt receives. */
export function renderResearchBrief(brief: ResearchBrief): string {
  const lines: string[] = [];
  if (brief.tools.length) {
    lines.push("Tools (each checked on its own site):");
    for (const t of brief.tools) {
      const parts = [
        `${t.name} (${t.url})`,
        t.job && `job: ${t.job}`,
        t.difference && `main difference: ${t.difference}`,
        t.pricing ? `starting price: ${t.pricing} [source: ${t.pricing_url}]` : "price: not published, link the site",
        t.limitation && `limitation: ${t.limitation}`,
        t.telegram && `Telegram: ${t.telegram}`,
      ].filter(Boolean);
      lines.push(`- ${parts.join("; ")}`);
    }
  }
  if (brief.facts.length) {
    lines.push("Facts:");
    for (const f of brief.facts) lines.push(`- ${f.claim} [source: ${f.source_url}]`);
  }
  if (brief.unverified.length) {
    lines.push("Could not verify (do NOT state these as fact):");
    for (const u of brief.unverified) lines.push(`- ${u}`);
  }
  return lines.join("\n");
}

/**
 * Run the research pass. Returns the rendered block for the article prompt,
 * or "" when research failed or found nothing.
 */
export async function researchTopic(query: string, depth: ResearchDepth): Promise<string> {
  const { searches, fetches } = LIMITS[depth];
  // The basic tool versions, not the _20260209 ones with dynamic filtering:
  // on the same three topics the basic pair answered in 16-47 seconds with a
  // full fact sheet, while the dynamic pair hit a 5-minute timeout every time.
  const tools = [
    { type: "web_search_20250305", name: "web_search", max_uses: searches },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: fetches, max_content_tokens: 20000 },
  ] as unknown as Anthropic.Messages.ToolUnion[];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Article topic: "${query}"\n\nResearch it and return the JSON fact sheet.` },
  ];

  try {
    let response: Anthropic.Message | undefined;
    // The fact sheet can arrive in any turn of a paused-and-resumed exchange,
    // so collect the text of every turn, not only the last.
    const texts: string[] = [];
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        // Thinking stays off, as on every other call in the pipeline: the
        // fact sheet is gathered by tools, not by long reasoning.
        thinking: { type: "disabled" },
        max_tokens: 8000,
        tools,
        system: researchSystemPrompt(depth, new Date().toISOString().slice(0, 10)),
        messages,
      }, { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
      for (const b of response.content) if (b.type === "text") texts.push(b.text);
      // The server-side tool loop hit its iteration cap: send the paused turn
      // back as is and the server resumes it. No extra "continue" message.
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content });
    }

    const brief = parseResearchBrief(texts.join("\n"));
    if (!brief) {
      logger.warn({ query, depth, stop: response?.stop_reason }, "Research returned no usable fact sheet");
      return "";
    }
    logger.info(
      { query, depth, tools: brief.tools.length, facts: brief.facts.length, unverified: brief.unverified.length },
      "Research complete"
    );
    return renderResearchBrief(brief);
  } catch (e) {
    logger.error({ query, depth, error: e instanceof Error ? e.message : "unknown" }, "Research failed — writing without it");
    return "";
  }
}
