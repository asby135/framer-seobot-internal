import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { searchKB, kbExcerpt, articleTextForFactCheck } from "./kb.js";
import { generateThumbnail, processScreenshots } from "./assets.js";
import { queryToSlug, uniqueSlug } from "../lib/utils.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { sanitizeJsonLd } from "../lib/jsonld.js";
import { namesCompetitor } from "../lib/competitors.js";
import { normalizeBrand } from "../lib/brand.js";
import { lintArticle } from "../lib/guide-lint.js";
import { researchTopic, type ResearchDepth } from "./research.js";
import { findBrokenLinks } from "./link-check.js";
import { TITLE_RULES } from "./title-rules.js";
import { titleTokens, TROUBLESHOOTING_SHAPE } from "./similarity.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

interface GeneratedArticle {
  title: string;
  slug: string;
  category: string;
  summary: string;
  content: string; // HTML
  schema_jsonld: string; // JSON-LD FAQPage as a stringified JSON document (Framer emits BlogPosting itself)
}

interface GenerationResult {
  articleId: string;
  status: "draft" | "review" | "generation_failed";
  flags: Record<string, unknown>;
}

// Allowed HTML tags for sanitization (no scripts, no event handlers)
const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "a", "strong", "em", "b", "i", "u",
  "blockquote", "pre", "code",
  "img", "figure", "figcaption",
  "table", "thead", "tbody", "tr", "th", "td",
  "div", "span",
]);

const ALLOWED_ATTRS = new Set([
  "href", "src", "alt", "title", "loading", "class", "id",
]);

/**
 * Generate an article for an approved keyword.
 * Pipeline: context assembly → Claude generation → quality checks → grounding → assets → save.
 */
export async function generateArticle(
  keywordId: string,
  query: string,
  /**
   * Headline approved by the operator at gate 1. When present it is pinned
   * verbatim and the post-generation tic check is skipped — silently rewriting
   * an approved title would break the gate's contract.
   */
  approvedTitle?: string,
  /** Operator's editing instructions for a regeneration (see editingInstructionsBlock). */
  instructions?: string
): Promise<GenerationResult> {
  const flags: Record<string, unknown> = {};

  try {
    // Step 1: Context assembly. 4 docs: a retrieval pin (see kb.ts PINS) can take
    // one slot for the strategically-preferred workflow, leaving 3 for TF-IDF.
    const kbResults = searchKB(query, 4);
    if (kbResults.length === 0) {
      flags.low_kb_match = true;
      logger.warn({ query }, "No KB articles matched query");
    }

    const relatedQueries = getRelatedQueries(query);
    const existingSlugs = getExistingSlugs();
    const existingArticles = getExistingArticlesForLinking();

    // Step 2: Web research — a fact sheet with a source URL per fact, which
    // the article must use for every claim about other products and every
    // number. Empty on failure; the article is then written from the KB alone.
    const research = await researchTopic(query, researchDepthFor(query));

    // Step 3: Claude generation (with retry on timeout/500)
    let article = await callClaudeWithRetry(query, kbResults, relatedQueries, existingSlugs, existingArticles, approvedTitle, instructions, research);

    // Step 3a: The writing guide's countable rules. One revision pass on the
    // problems found; what survives goes to the operator with the article.
    const needsTable = ["tops", "comparison"].includes(articleTypeOf(query));
    let guideIssues = lintArticle(article.content, { needsTable });
    // Broken internal links and a wrong length are fixable in the same pass.
    const fixable = runQualityChecks(article, query, existingSlugs).filter((i) => /^(Broken internal link|Article too (long|short))/.test(i));
    if (guideIssues.length > 0 || fixable.length > 0) {
      logger.info({ query, guideIssues, fixable }, "Revising draft against the writing guide");
      const revised = await reviseArticle(article, [...guideIssues, ...fixable], research, approvedTitle, existingArticles).catch((e) => {
        logger.warn({ query, error: e instanceof Error ? e.message : "unknown" }, "Guide revision failed — keeping the draft");
        return null;
      });
      if (revised) {
        const after = lintArticle(revised.content, { needsTable });
        // Never trade a draft for a revision that broke more than it fixed.
        if (after.length <= guideIssues.length) {
          article = revised;
          guideIssues = after;
        }
        logger.info({ query, remaining: guideIssues }, "Guide revision done");
      }
    }

    // Step 3b: Quality checks
    const qualityIssues = runQualityChecks(article, query, existingSlugs);
    qualityIssues.push(...guideIssues.map((i) => `Guide: ${i}`));
    const brokenLinks = await findBrokenLinks(article.content);
    qualityIssues.push(...brokenLinks.map((b) => `Broken link (${b.status}): ${b.url}`));
    if (qualityIssues.length > 0) {
      flags.quality_issues = qualityIssues;
      logger.warn({ query, issues: qualityIssues }, "Quality check issues");
    }

    // Step 4: Grounding validation
    if (kbResults.length > 0) {
      const ungroundedClaims = await validateGrounding(article.content, kbResults);
      if (ungroundedClaims.length > 0) {
        flags.ungrounded_claims = ungroundedClaims;
        logger.warn({ query, claims: ungroundedClaims }, "Ungrounded claims found");
      }
    }

    // Step 5: Save article to database first (assets reference article via FK)
    const articleId = nanoid();
    const db = getDb();
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, category, summary, content, schema_jsonld, status, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', '{}')`
    ).run(
      articleId,
      keywordId,
      article.title,
      article.slug,
      article.category,
      article.summary,
      article.content,
      article.schema_jsonld
    );

    // Step 6: Asset generation (parallel thumbnail + screenshot processing)
    let finalContent = article.content;

    const [thumbnailUrl, screenshotResult] = await Promise.all([
      generateThumbnail(articleId, article.title, query).catch((e) => {
        logger.error({ error: e instanceof Error ? e.message : "unknown" }, "Thumbnail failed");
        return null;
      }),
      processScreenshots(articleId, article.content).catch((e) => {
        logger.error({ error: e instanceof Error ? e.message : "unknown" }, "Screenshots failed");
        return { html: article.content, failed: [] as string[] };
      }),
    ]);

    finalContent = screenshotResult.html;

    if (!thumbnailUrl) {
      flags.thumbnail_missing = true;
    }
    if (screenshotResult.failed.length > 0) {
      flags.screenshots_failed = screenshotResult.failed;
    }

    // Step 7: Update article with final content and flags
    const status =
      Object.keys(flags).length > 0 ? "review" : ("draft" as const);

    finalizeArticle(db, articleId, finalContent, status, flags);

    // Update keyword status
    db.prepare("UPDATE keywords SET status = 'generated' WHERE id = ?").run(
      keywordId
    );

    logSync("generate", 1, "success");
    logger.info({ articleId, query, status }, "Article generated");

    return { articleId, status, flags };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    logger.error({ error: message, query }, "Article generation failed");

    // Mark keyword as failed so it doesn't block the queue
    const db = getDb();
    const articleId = insertFailedArticle(db, keywordId, query, message);

    logSync("generate", 0, "error");

    return {
      articleId,
      status: "generation_failed",
      flags: { error: message },
    };
  }
}

// --- Claude API calls with retry ---

async function callClaudeWithRetry(
  query: string,
  kbResults: Array<{ title: string; content: string }>,
  relatedQueries: string[],
  existingSlugs: Set<string>,
  existingArticles: Array<{ slug: string; title: string }>,
  approvedTitle?: string,
  instructions?: string,
  research = ""
): Promise<GeneratedArticle> {
  try {
    return await callClaude(query, kbResults, relatedQueries, existingSlugs, existingArticles, approvedTitle, instructions, research);
  } catch (e) {
    const isRetryable =
      e instanceof Error &&
      (e.message.includes("timeout") ||
        e.message.includes("500") ||
        e.message.includes("529") ||
        e.message.includes("overloaded"));

    if (!isRetryable) throw e;

    logger.warn({ query, error: e instanceof Error ? e.message : "unknown" }, "Claude API failed, retrying in 30s");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return await callClaude(query, kbResults, relatedQueries, existingSlugs, existingArticles, approvedTitle, instructions, research);
  }
}

/**
 * How much web research a topic gets. Listicles, comparisons, topics that name
 * a competitor and topics about other tools get the full pass: a shortlist of
 * tools checked on their own sites. Everything else (mostly how-tos about
 * crmchat, which the knowledge base covers) gets a light pass.
 */
export function researchDepthFor(topic: string): ResearchDepth {
  if (["tops", "comparison"].includes(articleTypeOf(topic))) return "full";
  if (namesCompetitor(topic)) return "full";
  if (/\b(tools?|software|apps?|platforms?|builders?|services|plugins?|extensions?|integrations?)\b/i.test(topic)) return "full";
  return "light";
}

/**
 * The `title` field instruction for the publish_article tool.
 *
 * When the operator has approved a headline at gate 1, it is pinned verbatim
 * and the ban-list is deliberately NOT restated — repeating it invites the
 * model to "improve" an already-approved string, which would silently break
 * the contract the gate exists to enforce.
 */
export function buildTitleInstruction(approvedTitle?: string): string {
  if (approvedTitle) {
    const safe = approvedTitle.replace(/"/g, '\\"');
    return `Use this EXACT title, verbatim, with no changes whatsoever: "${safe}". It has already been approved by the operator. Write the article body to fit this headline.`;
  }
  // No approved title (manual generation). Use the same house style every other
  // title-writing prompt uses, rather than a second, divergent set of rules —
  // that divergence is what let titles drift away from their keyword before.
  return `Article title, following these rules exactly:\n\n${TITLE_RULES}`;
}

/**
 * The article prompt. Static, and exported so the rules it states are testable.
 *
 * Its title section defers to TITLE_RULES (via the tool's title field). It used
 * to carry its own TITLE CRAFT rules — reframe the keyword, lead with pain, vary
 * the shape — the opposite of the house style, so an unpinned title got two
 * contradictory briefs. Only the competitor-pricing reframe remains, named as
 * the exception it is.
 */
export const GENERATOR_SYSTEM_PROMPT = `You write blog articles for crmchat — a Telegram-based CRM and outreach platform for sales teams. Articles are tuned for AEO/GEO: getting cited by ChatGPT, Perplexity, and Claude when users ask about Telegram CRMs, outreach, and adjacent topics.

VOICE & TONE:
- Write like you're explaining something to a smart friend: friendly, direct, no fluff
- Use "you" and "your". Never "one should" or "businesses can leverage"
- One sentence is one complete thought, under 35 words. Do not chain clauses with and / because / which, and do not stack short chopped fragments ("Teams need speed. They need scale.")
- Short paragraphs (2-3 sentences), and vary their length and construction
- Be opinionated: take a stance, say what works and what doesn't
- Light humor is fine but keep it universal: no cultural jokes, puns or idioms that break when translated to Russian

AEO/GEO RULES (THE WRITING GUIDE):

AI assistants cut articles into chunks and quote the chunk that answers the question. Every rule below makes a chunk quotable on its own. Follow all of them.

1. KEY TAKEAWAYS FIRST:
   - The content starts with <p><strong>Key takeaways</strong></p> and a <ul> of 3-5 items, 50-100 words in total.
   - Each item is concrete: a tool, a number with its source, an audience. No generic lines.

2. ANSWER IN THE FIRST 100 WORDS:
   - After the takeaways, an intro paragraph of 40-60 words answers the title directly (for a listicle: names the main options and what each one wins at). It adds something the takeaways did not say.
   - BANNED openers: "In today's...", "In this article we will cover...", "If you're looking for...", a rhetorical question as the first line, a scene-setting story before the answer.

3. QUESTION HEADINGS THAT ARE ANSWERED AT ONCE:
   - Phrase <h2>/<h3> headings as the question a reader would type ("Which email API is cheapest at 1M emails a month?").
   - The first sentence under a heading fully answers it, and does not begin with "This" or "It".
   - Each section stands on its own: no "as mentioned above", "earlier we covered", "below".
   - Sections run 120-180 words; above 200, split with a sub-heading.
   - One article answers one query. Name products in full, never "the platform" or "this tool".

4. MINIMUM 2 BRAND-MENTION SENTENCES IN CANONICAL ANSWER-FORM:
   - Format: "crmchat [is / includes / automates / handles / lets you] [specific feature] that [does specific X]."
   - These get lifted verbatim by LLMs into citations. That's the entire point.
   - Place them in distinct sections, not stacked together (so LLMs can lift one or the other based on which section matches the query).
   - Example: "crmchat includes built-in account warming features that automate this process while keeping activity natural."
   - Do NOT invent features. Only use what the knowledge base supports.

5. A TACTICAL LIST FOR "WHAT TO DO":
   - Every article has at least one <ul> or <ol> of concrete, actionable steps with specific verbs ("Add", "Set", "Monitor").
   - Do not give every section a list of exactly three items.

6. FAQ AT THE END:
   - Finish with <h2>FAQ</h2> and 3-5 <h3> questions people ask AI assistants, each answered in 2-3 sentences.

FACTS AND NUMBERS:
- Every number links to its primary source in the same sentence: a crmchat page from the knowledge base, a source URL from the VERIFIED RESEARCH block, or a study or report at most 12 months old. Statistics roundups do not count.
- No source, no number. Never invent illustrative numbers ("4,000 installs", "a 14,000-line repo").
- Prices and features of other tools come only from their official pages. A vendor's claim about itself ("saves 30% vs competitors") is not a fact: leave it out.
- Never attribute integrations, markets or customers to a product unless the source says so.
- Be specific instead of generic: not "saves time" but what is saved, and how much, if sourced.

STYLE BANS:
- No em dashes (—) and no double hyphens (--). Use full stops, commas, colons or brackets.
- No filler words: leverage, seamless, unlock, empower, elevate, revolutionize, game-changer, robust, streamline, cutting-edge, best-in-class, world-class, ultimate, synergy.
- No AI vocabulary: delve, tapestry, testament to, realm, myriad, plethora, embark, paramount, harness the power.
- No stock openings or endings: in today's fast-paced world, ever-evolving landscape, now more than ever, in conclusion, to sum up, at the end of the day, ultimately the right choice depends on your needs.
- No empty connectors: that being said, having said that, needless to say, it's worth noting, let's dive in, the sections below unpack, the FAQ below answers.
- No "not just X, but Y", "whether you're X or Y", "it's not about X, it's about Y". No rhetorical transition questions ("So why does this matter?").
- No hedge pile-ups (might potentially, could perhaps). No lines that fit any product ("helps teams work smarter").
- No metaphors (blind spot, duct tape, glue, changes the math): say the literal thing.
- No claims about other articles ("most roundups skip..."). At most one "!" per article.

ARTICLE TYPE — MATCH THE STRUCTURE TO THE KEYWORD:

The target keyword is the basis. Don't change the topic — but FIRST classify the keyword into one of these five archetypes and follow that archetype's structure and length. When the type is ambiguous, default to How-to: it's the highest-volume, highest-value format.

1. HOW-TO — the default; most keywords are this. Looks like "how to X", "X setup guide", "X integration", "X workflow".
   - 1,000-1,500 words. 4-6 <h2> sections.
   - Solve ONE specific technical problem with concrete step-by-step instructions.
   - This is the format that earns the most traffic — treat it as the priority type.

2. WHAT-IS — looks like "what is X", "X meaning", "X explained", "X definition".
   - SHORT: 400-600 words of body, plus the takeaways and a short FAQ. 2-3 <h2> sections. Do NOT pad to 1,500 — brevity IS the format.
   - Define the thing clearly in the first paragraph, then why it matters and how it works.

3. COMPARISON / ALTERNATIVE — looks like "X vs Y", "X alternatives", "best X alternative".
   - 800-1,200 words. A comparison table right after the intro, then paired sections.
   - Low search volume, but the hottest-intent audience — these readers are close to deciding.
   - Also follow the COMPETITOR & COMPARISON TOPICS rules below.

4. TOP / LISTICLE — looks like "best X", "top X tools", "X tools for Y".
   - 1,000-1,800 words.
   - Right after the intro: a comparison table of every product, 3-5 columns of selection criteria. Then 1-3 sentences on how the products were chosen.
   - One <h2> per product. Start each description with the product's main difference, never "X is a platform that...".
   - Vary the descriptions: a different order of blocks and a different length for each. Not every product gets the same bullet template.
   - Each product says who it fits AND when it does not fit. A list where everything has only upsides reads as an ad.
   - crmchat may go first, without superlatives (no "the best", "#1", "leading", "ultimate"). Then honestly cover each other product with real pros AND cons: the honest coverage is what makes the list citable.

5. TROUBLESHOOTING / FAQ — looks like "X not working", "fix X", "X error", or a direct question.
   - 600-1,000 words. Problem → cause → fix structure, or Q&A blocks.

All five types follow the AEO/GEO RULES above, scaled to the type. A 400-word What-is has one quotable answer and one short list, not 4-6 sections.

TITLE:

The title follows the TITLE RULES in the publish_article tool's title field: the title IS the search query, stated plainly. When an approved title is given there, use it verbatim. The one deliberate exception is a competitor-pricing topic — see COMPETITOR & COMPARISON TOPICS below — where an explicit comparison or evaluation title is the better answer-engine bet.

crmchat MENTIONS (in body text):
- Write the brand exactly as "crmchat": all lowercase, also at the start of a sentence, in headings, link text, the title, the summary and the schema. Never "CRMChat" or "CRMchat", even where the knowledge base spells it that way.
- Beyond the 2 brand-mention sentences from Rule 3, additional mentions optional. 1-2 more max.
- For CRM/outreach/integration topics: mention the crmchat API (https://developers.crmchat.ai/) where relevant.
- For Web3/crypto/blockchain topics: mention crmchat's Web3 B2B decision-makers database (https://crmchat.ai/web3-database).
- Never invent features, pricing, or capabilities not in the knowledge base.

COMPETITOR & COMPARISON TOPICS:
Some topics name a competitor (e.g. "crmchat vs nReach", "Vtiger Telegram integration setup guide"). When the topic involves a competitor:
- If a "VERIFIED RESEARCH" block is provided in the user message, treat it as the source of truth for competitor facts. If a fact (especially pricing) is NOT in that block, do NOT state it as fact — write "check their site for current details" instead of inventing a number.
- For "X vs crmchat" topics: write an honest, balanced comparison. Do not disparage the competitor. Let crmchat win on the dimensions that genuinely matter — Telegram-native depth, no integration overhead — a fair comparison that lands favorably, never a hit piece.
- For "competitor + task/integration" topics (e.g. "Vtiger Telegram integration"): genuinely help the reader accomplish the task — that usefulness is what earns the citation. Then include crmchat as a natural reframe: "...or skip the integration overhead entirely, since crmchat is built on Telegram natively." An honest reframe, not a tacked-on ad.
- For "competitor + pricing/cost/plans/fees" topics (e.g. "Manychat pricing", "Vtiger cost", "amoCRM plans"): the vendor's own page ALWAYS ranks #1 on Google for these queries — you cannot outrank Manychat.com for "Manychat pricing". Win AEO instead by reframing the title into a citable shape. Pick ONE:
  (a) Explicit comparison: "Manychat vs crmchat: Real Pricing Breakdown for Telegram Teams"
  (b) Evaluation form: "Is Manychat Worth It for Telegram? Hidden Cost Breakdown"
  (c) Audience filter: "Manychat Pricing for Small Telegram Outreach Teams"
  NEVER mirror the bare brand-pricing query (e.g. "Manychat Pricing for Telegram"). Comparison and evaluation pages get cited 3x more often by AI engines than vendor pricing pages, because AI answers evaluation questions, not URL lookups.
- Never claim a competitor lacks a feature unless the research block confirms it. Inaccurate competitor claims destroy credibility — and AI engines won't cite a source they can't trust.
- For decision-maker / founder / B2B prospect-sourcing topics (especially Russia/CIS): lead with the DataNewton → crmchat contact-lookup workflow (registry data → founder phone number → phone-to-Telegram username, orchestrated by an AI assistant + @crmchatcontactbot) as the PRIMARY, recommended method — it targets verified decision-makers directly. Treat group parsing as a complementary secondary approach for broader audiences, never the headline for these topics. If the knowledge base includes the "finding decision-makers" workflow, that is the approach to feature.

HTML FORMAT:
- <h2> for main sections, <h3> for subsections.
- <p> for paragraphs, <ul>/<ol> + <li> for lists, <strong> for emphasis.
- Tables as HTML text, never as an image: <table><tbody><tr><th><p>Header</p></th></tr><tr><td><p>Cell</p></td></tr></tbody></table>
- <a href="/blog/slug"> for internal links to related existing articles (ONLY use slugs from the list provided — link 3-5 related articles where the reader needs the next step). The link text is 2-5 words, never the full article title.
- <!-- screenshot:https://example.com --> where a competitor screenshot would add value.

JSON-LD STRUCTURED DATA (schema_jsonld field):

Emit a STRING (the tool field) containing a valid JSON FAQPage document that mirrors the visible FAQ section, with this shape:
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "<H2 question 1>", "acceptedAnswer": { "@type": "Answer", "text": "<plain-text answer from first paragraph below that H2, 1-3 sentences>" } },
    ... 2 to 6 Q&A pairs distilled from your H2 sections that are questions — match the count to the article (a short What-is yields 2-3, a long How-to yields 4-6) ...
  ]
}

Emit ONLY the FAQPage — do NOT include a BlogPosting or Article node. Framer generates the BlogPosting/Article schema automatically from the CMS page; your job is the FAQPage it does not generate.

CRITICAL: This JSON-LD belongs ONLY in the schema_jsonld field. NEVER put it — or any part of it, any <script> tag, or raw JSON — inside the content field. The content field is article HTML only; if the schema leaks into content it renders as visible text in the published article.

The schema_jsonld value MUST be a valid JSON string. No backtick fences, no commentary, no trailing commas. Inside Answer.text, use plain text (no HTML tags). Pick the H2 sections that are framed as questions for the FAQ; if a section is a statement not a question, rephrase its first H2 line as a question for the FAQ entry (e.g., "5 Ways to Avoid Telegram Bans" → "How do I avoid Telegram bans?"). Use 2-6 Q&A pairs total, matched to the article's length and section count.

Call the publish_article tool with all six fields populated.`;

/**
 * The operator's editing instructions for a regeneration, as a labelled block
 * of the user message. They used to be pasted into the topic itself —
 * "<topic> [EDITING INSTRUCTIONS: …]" — which then drove knowledge-base search,
 * the keyword checks, the thumbnail prompt and the slug.
 */
export function editingInstructionsBlock(instructions: string | undefined): string {
  const text = instructions?.trim();
  if (!text) return "";
  return `\nEDITING INSTRUCTIONS from the operator for this rewrite — apply them; where they conflict with the defaults above, they win. They do not license new product facts: do not invent features, pricing or capabilities the knowledge base does not support.\n${text}\n`;
}

/** The research block for the article prompt, or nothing when research found nothing. */
function researchBlock(research: string): string {
  return research
    ? `\nVERIFIED RESEARCH (checked on the web today; the only source for claims about other products and for any number not from the crmchat knowledge base; link each number to its source URL in the same sentence or table cell):\n${research}`
    : "";
}

/** The structured-output tool both the article call and the revision call use. */
function publishArticleTool(approvedTitle?: string) {
  return {
    name: "publish_article",
    description: "Publish the generated blog article with all required fields.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: buildTitleInstruction(approvedTitle) },
        slug: { type: "string" as const, description: "URL-friendly slug" },
        category: { type: "string" as const, enum: ["outreach", "crm", "telegram", "sales", "automation", "guides"], description: "Article category" },
        summary: { type: "string" as const, description: "1-2 sentence meta description (under 155 chars)" },
        content: { type: "string" as const, description: "Full HTML article body following the AEO/GEO RULES. Article HTML ONLY — do NOT include the JSON-LD/FAQPage schema, any <script> tag, or raw JSON here. The schema goes ONLY in the schema_jsonld field." },
        schema_jsonld: {
          type: "string" as const,
          description:
            "Stringified JSON-LD FAQPage document. Must be a valid JSON string parseable by JSON.parse. " +
            "See AEO RULES → JSON-LD STRUCTURED DATA in the system prompt for required shape.",
        },
      },
      required: ["title", "slug", "category", "summary", "content", "schema_jsonld"],
    },
  };
}

async function callClaude(
  query: string,
  kbResults: Array<{ title: string; content: string }>,
  relatedQueries: string[],
  existingSlugs: Set<string>,
  existingArticles: Array<{ slug: string; title: string }>,
  approvedTitle?: string,
  instructions?: string,
  research = ""
): Promise<GeneratedArticle> {
  const kbContext = kbResults
    .map(
      (kb, i) =>
        `--- KB Article ${i + 1}: ${kb.title} ---\n${kbExcerpt(kb.content)}`
    )
    .join("\n\n");

  const relatedContext =
    relatedQueries.length > 0
      ? `\nRelated search queries people also search: ${relatedQueries.join(", ")}`
      : "";

  const existingArticlesList =
    existingArticles.length > 0
      ? `\nExisting blog articles — for internal linking: insert 3-5 <a href="/blog/slug"> links inside the body to relevant titles below, with link text of 2-5 words.
${existingArticles.map((a) => `- /blog/${a.slug} — "${a.title}"`).join("\n")}`
      : "";

  const sitePages = `
Key site pages you can link to where relevant:
- https://crmchat.ai/ — "crmchat homepage" (link when mentioning crmchat as a product)
- https://crmchat.ai/case-studies — "Case Studies" (link when referencing real results or success stories)
- https://crmchat.ai/help-center — "Help Center" (link when mentioning setup, configuration, or how-to for crmchat)
- https://crmchat.ai/telegram-account-warmup — "Telegram Account Warmup" (link when discussing account warmup or avoiding bans)
- https://developers.crmchat.ai/ — "crmchat API" (link when mentioning integrations, API, or developer features)`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    // Sonnet 5 defaults to adaptive thinking; disable to preserve 4.6 behavior
    // (forced tool_choice below + fixed token budget).
    thinking: { type: "disabled" },
    max_tokens: 16384,
    tools: [publishArticleTool(approvedTitle)],
    tool_choice: { type: "tool" as const, name: "publish_article" },
    system: GENERATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Target keyword: "${query}"
${kbContext ? `\ncrmchat knowledge base (use for accuracy — do NOT invent features):\n${kbContext}` : ""}
${researchBlock(research)}
${relatedContext}
${existingArticlesList}
${sitePages}
${editingInstructionsBlock(instructions)}
Write the article following the AEO/GEO rules and call the publish_article tool.`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    logger.error({ stopReason: response.stop_reason }, "Claude response truncated — tool_use output may be incomplete");
  }

  // Extract structured output from tool_use response
  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    logger.error({ stopReason: response.stop_reason, contentTypes: response.content.map((b) => b.type) }, "Claude did not return tool_use block");
    throw new Error("Claude did not return structured article output");
  }

  const parsed = toolBlock.input as GeneratedArticle;
  if (!parsed.title || !parsed.content) {
    logger.error({ input: JSON.stringify(parsed).slice(0, 500) }, "Tool output missing required fields");
    throw new Error("Claude returned incomplete article data");
  }

  // Ensure slug doesn't collide with existing articles
  const slug = uniqueSlug(queryToSlug(parsed.slug || parsed.title), existingSlugs);

  // Sanitize HTML content
  const sanitizedContent = sanitizeHTML(parsed.content || "");

  // Validate schema_jsonld parses as JSON. On failure, regenerate it once
  // via a follow-up call. On second failure, drop it (empty string) — the
  // article still publishes, just without the FAQPage rich data.
  const schemaJsonld = await validateOrRegenerateSchema(
    parsed.schema_jsonld || "",
    parsed.title,
    parsed.content || ""
  );

  // Validate title doesn't contain banned AI-content tics ("Actually",
  // "(Step-by-Step)", etc.). If it does, regenerate the title once. If the
  // retry still has tics, keep the original (don't block publishing).
  //
  // Skipped entirely when the operator approved a headline at gate 1: they
  // approved that exact string, so rewriting it here would mean publishing
  // something they never saw.
  const cleanTitle = approvedTitle
    ? approvedTitle
    : await validateOrRegenerateTitle(parsed.title, query, parsed.content || "");

  // The content's brand casing is fixed by sanitizeHTML; the other text fields here.
  return {
    title: normalizeBrand(cleanTitle),
    slug,
    category: parsed.category || "guides",
    summary: normalizeBrand(parsed.summary || ""),
    content: sanitizedContent,
    schema_jsonld: normalizeBrand(schemaJsonld),
  };
}

/**
 * One revision pass on the problems lintArticle found.
 *
 * The draft goes back with the list and the same research block, and comes
 * back whole through publish_article. The title is pinned (it may have been
 * approved at gate 1) and the model may not add facts: the pass restructures
 * and rewords, it does not research. Throws when the revision is unusable; the
 * caller then keeps the draft.
 */
async function reviseArticle(
  draft: GeneratedArticle,
  issues: string[],
  research: string,
  approvedTitle?: string,
  linkTargets: Array<{ slug: string; title: string }> = []
): Promise<GeneratedArticle> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    // Same settings as the article call: forced tool_choice + fixed budget.
    thinking: { type: "disabled" },
    max_tokens: 16384,
    tools: [publishArticleTool(approvedTitle ?? draft.title)],
    tool_choice: { type: "tool" as const, name: "publish_article" },
    system: GENERATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Revise this draft. Fix ONLY these problems with the writing guide:
${issues.map((i) => `- ${i}`).join("\n")}

Keep everything else: the title, every sourced fact, number and link, and what each section says. Do not add facts, numbers or claims that are not already in the draft or in the research block below. A number with no source link and no source in the research block is removed or rewritten without the number, never kept unsourced. Replace a broken internal link with one from the list below or drop the link. Return the whole article through publish_article.
${researchBlock(research)}
${linkTargets.length ? `\nArticles you may link to:\n${linkTargets.map((a) => `- /blog/${a.slug} — "${a.title}"`).join("\n")}` : ""}

DRAFT
Title: ${draft.title}
Summary: ${draft.summary}
Schema: ${draft.schema_jsonld}
Content:
${draft.content}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") throw new Error("Revision truncated");
  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") throw new Error("Revision returned no article");
  const revised = toolBlock.input as GeneratedArticle;
  if (!revised.content) throw new Error("Revision returned no content");

  return {
    ...draft,
    summary: normalizeBrand(revised.summary || draft.summary),
    content: sanitizeHTML(revised.content),
    // A revision that broke the schema keeps the draft's.
    schema_jsonld: normalizeBrand(sanitizeJsonLd(revised.schema_jsonld || "") ? revised.schema_jsonld : draft.schema_jsonld),
  };
}

/**
 * Banned title patterns — AI-content tells that destroy citation credibility.
 * Kept in sync with BANNED_TITLE_PHRASES in title-rules.ts.
 */
const BANNED_TITLE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bactually\b/i, label: "actually" },
  { pattern: /\breally\b/i, label: "really" },
  { pattern: /\bno[- ]fluff\b/i, label: "no-fluff" },
  { pattern: /\bno[- ]agency\b/i, label: "no-agency" },
  { pattern: /\bultimate\b/i, label: "ultimate" },
  { pattern: /\bcomplete guide\b/i, label: "complete guide" },
  { pattern: /\beverything you need\b/i, label: "everything you need" },
  { pattern: /\ba deep dive\b/i, label: "a deep dive" },
  { pattern: /\bwhat you need to know\b/i, label: "what you need to know" },
  { pattern: /\bthe truth about\b/i, label: "the truth about" },
  { pattern: /\(\s*step[- ]?by[- ]?step\s*\)/i, label: "(step-by-step) parenthetical" },
  { pattern: /\bin 20\d{2}\b/i, label: "year suffix" },
];

export function findTitleTics(title: string): string[] {
  return BANNED_TITLE_PATTERNS.filter(({ pattern }) => pattern.test(title)).map(({ label }) => label);
}

async function validateOrRegenerateTitle(
  title: string,
  query: string,
  content: string
): Promise<string> {
  const violations = findTitleTics(title);
  if (violations.length === 0) return title;

  logger.warn(
    { titlePreview: title.slice(0, 80), violations },
    "title contains banned tics, regenerating"
  );

  try {
    const retried = await regenerateTitle(query, content, title, violations);
    const retriedViolations = findTitleTics(retried);
    if (retriedViolations.length === 0) {
      logger.info(
        { originalTitle: title, newTitle: retried, violations },
        "title regenerated successfully"
      );
      return retried;
    }
    logger.error(
      { originalTitle: title, retried, retriedViolations },
      "title retry still has banned tics — keeping original"
    );
  } catch (e) {
    logger.error(
      { titlePreview: title.slice(0, 80), error: e instanceof Error ? e.message : "unknown" },
      "title retry call failed — keeping original"
    );
  }
  return title;
}

/**
 * Brief for removing banned tics from a title. It removes the tics and nothing
 * else: it used to also ask for a reframe ("don't copy it verbatim… lead with
 * pain… pick a shape"), the opposite of the house style in TITLE_RULES.
 */
export function buildTitleCleanupPrompt(query: string): string {
  return `Your previous title contained banned AI-content tics. Remove them and change nothing else of substance.

The title must still state the task "${query}" plainly — keep every substantive word of it.

${TITLE_RULES}

Return the cleaned title via the emit_title tool.`;
}

async function regenerateTitle(
  query: string,
  content: string,
  originalTitle: string,
  violations: string[]
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    // Sonnet 5 defaults to adaptive thinking; disable to preserve 4.6 behavior
    // (forced tool_choice below + tight 512-token budget).
    thinking: { type: "disabled" },
    max_tokens: 512,
    tools: [
      {
        name: "emit_title",
        description: "Emit a single cleaned-up article title.",
        input_schema: {
          type: "object" as const,
          properties: {
            title: {
              type: "string" as const,
              description:
                "Cleaned article title with the banned tics removed. Must not contain 'Actually', 'Really', 'Ultimate', 'Complete Guide', 'Everything You Need', 'A Deep Dive', 'No-Fluff', 'No-Agency', 'The Truth About', '(Step-by-Step)'-style parentheticals, or year suffixes.",
            },
          },
          required: ["title"],
        },
      },
    ],
    tool_choice: { type: "tool" as const, name: "emit_title" },
    system: buildTitleCleanupPrompt(query),
    messages: [
      {
        role: "user",
        content: `ORIGINAL TITLE (rewrite this): ${originalTitle}
VIOLATIONS FOUND: ${violations.join(", ")}

ARTICLE FIRST 1500 CHARS (for context — anchor the rewrite in the actual content):
${content.slice(0, 1500)}

Emit a clean replacement title via the emit_title tool.`,
      },
    ],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Title regeneration did not return tool_use block");
  }
  const out = (toolBlock.input as { title?: string }).title;
  if (!out || typeof out !== "string") {
    throw new Error("Title regeneration returned no title");
  }
  return out.trim();
}

/**
 * Validate that schema_jsonld parses as JSON AND has the minimum required
 * shape. If invalid, regenerate via a smaller targeted Claude call. If THAT
 * also fails, return an empty string — Framer's template will render an empty
 * <script> tag, no breakage.
 */
async function validateOrRegenerateSchema(
  raw: string,
  title: string,
  content: string
): Promise<string> {
  // sanitizeJsonLd returns an HTML-<script>-safe serialization, or null if
  // the input isn't valid JSON-LD. The returned string is what we persist —
  // never the raw LLM output (which could contain a </script> breakout).
  const sanitized = sanitizeJsonLd(raw);
  if (sanitized) return sanitized;

  logger.warn(
    { titlePreview: title.slice(0, 60), rawPreview: raw.slice(0, 200) },
    "schema_jsonld invalid on first pass, retrying"
  );

  try {
    const retried = await regenerateSchemaJsonld(title, content);
    const retriedSanitized = sanitizeJsonLd(retried);
    if (retriedSanitized) {
      logger.info({ titlePreview: title.slice(0, 60) }, "schema_jsonld regenerated successfully on retry");
      return retriedSanitized;
    }
    logger.error(
      { titlePreview: title.slice(0, 60), retryPreview: retried.slice(0, 200) },
      "schema_jsonld invalid on retry, dropping"
    );
  } catch (e) {
    logger.error(
      { titlePreview: title.slice(0, 60), error: e instanceof Error ? e.message : "unknown" },
      "schema_jsonld retry call failed, dropping"
    );
  }
  return "";
}

async function regenerateSchemaJsonld(
  title: string,
  content: string
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    // Sonnet 5 defaults to adaptive thinking; disable to preserve 4.6 behavior
    // (forced tool_choice below + fixed token budget).
    thinking: { type: "disabled" },
    max_tokens: 2048,
    tools: [
      {
        name: "emit_schema",
        description: "Emit valid JSON-LD as a stringified JSON document.",
        input_schema: {
          type: "object" as const,
          properties: {
            schema_jsonld: {
              type: "string" as const,
              description: "Stringified JSON-LD FAQPage. MUST parse as JSON.",
            },
          },
          required: ["schema_jsonld"],
        },
      },
    ],
    tool_choice: { type: "tool" as const, name: "emit_schema" },
    system: `Your previous schema_jsonld output was unparseable as JSON. Emit a valid JSON-LD FAQPage document for the article below.

Required shape:
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "<H2 question 1>", "acceptedAnswer": { "@type": "Answer", "text": "<plain-text answer>" } },
    ... 2-6 Q&A pairs distilled from the article's H2 sections ...
  ]
}

Emit ONLY the FAQPage — no BlogPosting or Article node (Framer generates that automatically).
Return ONLY the stringified JSON. No backticks, no commentary, no trailing commas. Inside Answer.text use plain text only.`,
    messages: [
      {
        role: "user",
        content: `TITLE: ${title}

ARTICLE HTML (extract H2 questions and first-paragraph answers for the FAQPage):
${content.slice(0, 8000)}

Emit valid JSON-LD via the emit_schema tool.`,
      },
    ],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Schema retry: tool_use block missing");
  }
  const input = toolBlock.input as { schema_jsonld?: string };
  return input.schema_jsonld || "";
}

async function validateGrounding(
  articleContent: string,
  kbResults: Array<{ title: string; content: string }>
): Promise<string[]> {
  try {
    const kbContext = kbResults
      // The same excerpt the writer saw, so a claim it grounded is checkable.
      .map((kb) => `--- ${kb.title} ---\n${kbExcerpt(kb.content)}`)
      .join("\n\n");

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are a fact-checker. Compare the article against the product knowledge base.
Identify any specific product claims (pricing, features, capabilities, limitations) in the article that are NOT supported by the knowledge base.
Respond with a JSON array of strings, each being an ungrounded claim.
If all claims are grounded, respond with an empty array: []
Only flag specific, verifiable product claims. General marketing language or industry knowledge is fine.`,
      messages: [
        {
          role: "user",
          content: `ARTICLE:\n${articleTextForFactCheck(articleContent)}\n\nKNOWLEDGE BASE:\n${kbContext}`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "[]";
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");

    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed as string[];
      return [];
    } catch {
      // Try to extract JSON array from the response
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          const parsed = JSON.parse(arrayMatch[0]);
          if (Array.isArray(parsed)) return parsed as string[];
        } catch { /* fall through */ }
      }
      logger.error({ text: cleaned.slice(0, 200) }, "Grounding check returned invalid JSON");
      return ["Grounding validation returned invalid response - manual review recommended"];
    }
  } catch (e) {
    logger.error(
      { error: e instanceof Error ? e.message : "unknown" },
      "Grounding validation failed"
    );
    return ["Grounding validation failed - manual review recommended"];
  }
}

// --- HTML Sanitization ---

/**
 * Strip dangerous tags and attributes from generated HTML.
 * Allows only safe structural/content tags.
 */
/**
 * Strip JSON-LD schema the model sometimes leaks into the article body.
 *
 * The publish_article tool has a separate `schema_jsonld` field, but the model
 * occasionally ALSO appends the FAQPage JSON-LD as trailing raw text inside the
 * `content` field. That JSON belongs only in schema_jsonld (Framer injects it as
 * a <script type="application/ld+json"> tag) — in the body it renders as visible
 * text. The leaked blob always begins with a schema.org @context or a FAQPage
 * @type object and sits at the end of the content, so cut from the first such
 * marker to end-of-content. These markers do not occur in normal article prose.
 */
export function stripLeakedJsonLd(html: string): string {
  // A marker inside <pre> or <code> is an example the article is showing, not
  // a leak — cutting there deleted the rest of the article.
  const marker = /\{\s*"@context"\s*:\s*"https?:\/\/schema\.org"|\{\s*"@type"\s*:\s*"FAQPage"/g;
  let m = -1;
  for (const found of html.matchAll(marker)) {
    if (!insideCodeBlock(html, found.index!)) {
      m = found.index!;
      break;
    }
  }
  if (m === -1) return html;
  let out = html.slice(0, m);
  // Drop a now-dangling trailing open wrapper tag (e.g. a "<p>" that wrapped the JSON).
  out = out.replace(/\s*<(?:p|div|span|pre|code)>\s*$/i, "");
  return out.trimEnd();
}

/** Is `index` inside an open <pre> or <code> element? */
function insideCodeBlock(html: string, index: number): boolean {
  const before = html.slice(0, index).toLowerCase();
  return ["pre", "code"].some((tag) => before.lastIndexOf(`<${tag}`) > before.lastIndexOf(`</${tag}`));
}

/**
 * Strip a trailing bare "placeholder" text node.
 *
 * Observed on 6 of 308 published articles (5 trailing). Nothing in this
 * codebase emits it — it is model output that survived sanitisation and
 * shipped to the live site.
 *
 * Deliberately narrow: only a trailing occurrence that is the ENTIRE remaining
 * content is removed. "Placeholder" is a legitimate word in articles about
 * form fields and message templates, so a broader match would corrupt real
 * content.
 */
export function stripTrailingPlaceholder(html: string): string {
  // Two shapes only, and in both the word must be the ENTIRE trailing node:
  //   1. <p>placeholder</p>  — a paragraph containing nothing else
  //   2. ...</p>\n\nplaceholder — a bare text node after the last element
  //
  // The word must NOT be preceded by prose. An earlier version matched
  // /placeholder\s*<\/p>$/ and turned "<p>The final field is a placeholder</p>"
  // into "<p>The final field is a" — truncated text and unbalanced HTML, on
  // every generated article. "Placeholder" is ordinary vocabulary in articles
  // about form fields and message templates.
  const wholeParagraph = /<p[^>]*>\s*placeholder\s*<\/p>\s*$/i;
  const bareTextNode = /(>|^)\s*placeholder\s*$/i;

  let stripped = html.replace(wholeParagraph, "");
  if (stripped === html) {
    // Keep the delimiter that ended the previous element.
    stripped = html.replace(bareTextNode, (_m, lead: string) => lead);
  }

  // Only touch the content when something was actually removed. Trimming
  // unconditionally rewrites every article for no reason, which makes audits
  // noisy and diffs meaningless.
  return stripped === html ? html : stripped.trimEnd();
}

/**
 * Strip a bare tag named after the schema field ("<schema_jsonld>",
 * "<schema_jsonld_placeholder/>") that the model sometimes appends to the body.
 *
 * stripLeakedJsonLd catches the JSON itself; this is the tag alone, with no
 * JSON after it. "_" is not tag syntax to the TOKEN pass below, so the "<" was
 * escaped and the tag shipped as visible text — 8 live articles ended in
 * "<schema_jsonld>". Matched raw or already escaped, and the paragraph that
 * held nothing else goes with it.
 */
export function stripSchemaFieldTags(html: string): string {
  const tag = String.raw`(?:<|&lt;)\/?schema_json\w*[^<>&]*?\/?(?:>|&gt;)`;
  const stripped = html
    .replace(new RegExp(String.raw`<p[^>]*>\s*(?:${tag}\s*)+<\/p>`, "gi"), "")
    .replace(new RegExp(tag, "gi"), "");
  return stripped === html ? html : stripped.trimEnd();
}

export function sanitizeHTML(html: string): string {
  // Remove any JSON-LD schema the model leaked into the body (belongs in schema_jsonld).
  let clean = stripSchemaFieldTags(stripLeakedJsonLd(normalizeBrand(html)));

  // Remove a trailing bare "placeholder" text node — a recurring model artifact.
  clean = stripTrailingPlaceholder(clean);

  // Remove script and style blocks with their content.
  clean = clean.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  clean = clean.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");

  // One pass over real markup; everything between tags is text.
  //
  // A tag is recognised only by real tag syntax: a letter after "<", and
  // attribute values that may be quoted (and so may contain "<" or ">"). Any
  // other "<" is text and is escaped. The previous pattern, /<\/?(\w+)([^>]*)>/,
  // read "<5%" or "<50" as a tag named "5"/"50" and deleted everything up to the
  // next ">" — the rest of the sentence and its closing tags.
  //
  // Event handlers and unsafe URLs are removed by the attribute allowlist below,
  // inside tags only. The old global regexes for them ran over prose too, and
  // turned "set online=true" into "set".
  //
  // Comments: only the screenshot placeholder survives, in its exact shape —
  // processScreenshots() needs it. Every other comment is dropped. Passing
  // comments through was an XSS hole: browsers end a comment at "<!-->",
  // "<!--->" or "--!>", earlier than the pattern thinks, so markup "inside"
  // one reached the page.
  return clean.replace(TOKEN, (match, tag: string | undefined, attrs: string | undefined, text: string | undefined) => {
    if (text !== undefined) return text.replace(/</g, "&lt;");
    if (tag === undefined) return SCREENSHOT_PLACEHOLDER.test(match) ? match : ""; // a comment
    const lowerTag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(lowerTag)) return "";
    if (match.startsWith("</")) return `</${lowerTag}>`;
    return `<${lowerTag}${filterAttributes(attrs ?? "")}>`;
  });
}

/**
 * Comments, tags (with quoted or unquoted attribute values), or a run of text.
 * A "<" that starts neither a comment nor a tag is matched as text on its own.
 */
//
// Attribute names and unquoted values exclude "<": allowing it made the
// pattern quadratic on input like "<a <a <a …" (34 s at 200k characters).
const TOKEN =
  /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*\/?>|([^<]+|<)/g;

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

/**
 * The one comment allowed through: a screenshot placeholder whose URL cannot
 * break out of the attribute processScreenshots() later puts it in.
 */
const SCREENSHOT_PLACEHOLDER = /^<!-- screenshot:https?:\/\/[^\s<>"'`]+ -->$/;

/** Keep allowlisted attributes that have a value, with link targets checked. */
function filterAttributes(attrs: string): string {
  let out = "";
  for (const m of attrs.matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined || !ALLOWED_ATTRS.has(name)) continue;
    if ((name === "href" || name === "src") && !isSafeUrl(value)) continue;
    out += ` ${name}="${value.replace(/"/g, "&quot;")}"`;
  }
  return out;
}

/**
 * Relative paths, fragments, and http(s)/mailto/tel/tg links only. Anything with an
 * entity or control character is refused outright: browsers decode
 * "java&#x09;script:" into a working javascript: URL.
 */
export function isSafeUrl(raw: string): boolean {
  const value = raw.trim();
  if (/&#|&colon;|&tab;|&newline;/i.test(value) || /[\x00-\x1f]/.test(value)) return false;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return true;
  // tg: — Telegram deep links (tg://resolve?domain=…) belong on a Telegram blog.
  return ["http", "https", "mailto", "tel", "tg"].includes(scheme[1].toLowerCase());
}

// --- Quality checks ---

export type ArticleType = "how-to" | "what-is" | "comparison" | "tops" | "troubleshooting";

/**
 * Word-count bounds per article type: the prompt's ARTICLE TYPE ranges with
 * about 25% slack either side. KEEP IN STEP with that section of the prompt —
 * a single 800-1,800 band for every type contradicted it, so what-is and
 * troubleshooting articles written exactly as instructed were flagged.
 */
const LENGTH_BOUNDS: Record<ArticleType, [number, number]> = {
  "how-to": [750, 1900], // prompt: 1,000-1,500
  "what-is": [350, 950], // prompt: 400-600 plus takeaways and FAQ
  comparison: [600, 1500], // prompt: 800-1,200
  tops: [750, 2300], // prompt: 1,000-1,800
  troubleshooting: [450, 1300], // prompt: 600-1,000
};

/** The prompt's archetype rules, applied to a topic. How-to is the default. */
export function articleTypeOf(topic: string): ArticleType {
  const t = topic.toLowerCase().trim();
  if (TROUBLESHOOTING_SHAPE.test(t)) return "troubleshooting";
  if (/\bwhat (is|are)\b|\bexplained\b|\bmeaning\b|\bmean\b|\bdefinition\b/.test(t)) return "what-is";
  if (/\bvs\.?\b|\bversus\b|\balternatives?\b/.test(t)) return "comparison";
  if (/^(best|top)\b|\b(best|top) \d+\b|\btools for\b/.test(t)) return "tops";
  return "how-to";
}

/** Share of the topic's meaningful words that appear in `text`. */
function topicCoverage(topic: string, text: string): number {
  const wanted = titleTokens(topic);
  if (wanted.size === 0) return 1;
  const present = titleTokens(text);
  let hit = 0;
  for (const w of wanted) if (present.has(w)) hit++;
  return hit / wanted.size;
}

export function runQualityChecks(
  article: GeneratedArticle,
  query: string,
  existingSlugs: Set<string>
): string[] {
  const issues: string[] = [];

  // The topic by its meaningful words, not as an exact string: a title may
  // reorder the task or add words to it (and used to be told to reframe it), so
  // an exact-substring test flagged nearly every article.
  if (topicCoverage(query, article.title) < 0.6) {
    issues.push("Title drifts from the topic");
  }
  // The intro is the first paragraph after the Key takeaways block, if any.
  const afterTakeaways = article.content.replace(/^\s*<(?:p|h2|h3)>\s*(?:<strong>)?\s*Key takeaways[\s\S]*?<\/ul>/i, "");
  const firstPara = afterTakeaways.match(/<p>(.*?)<\/p>/s);
  if (firstPara && topicCoverage(query, firstPara[1].replace(/<[^>]+>/g, " ")) < 0.5) {
    issues.push("Topic not introduced in the first paragraph");
  }

  // Length against this article's own type (see LENGTH_BOUNDS).
  const type = articleTypeOf(query);
  const [min, max] = LENGTH_BOUNDS[type];
  const plainText = article.content.replace(/<[^>]+>/g, " ");
  const wordCount = plainText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < min) {
    issues.push(`Article too short for a ${type} article: ${wordCount} words (minimum ${min})`);
  }
  if (wordCount > max) {
    issues.push(`Article too long for a ${type} article: ${wordCount} words (maximum ${max})`);
  }

  // Validate internal links
  const linkRegex = /href="\/blog\/([^"]+)"/g;
  let match;
  while ((match = linkRegex.exec(article.content)) !== null) {
    if (!existingSlugs.has(match[1])) {
      issues.push(`Broken internal link: /blog/${match[1]}`);
    }
  }

  return issues;
}

// --- Helpers ---

function getRelatedQueries(query: string): string[] {
  const db = getDb();
  const queryTerms = query.toLowerCase().split(/\s+/);
  const rows = db
    .prepare(
      `SELECT query FROM keywords
       WHERE status IN ('pending', 'approved') AND id != ''
       ORDER BY opportunity_score DESC LIMIT 50`
    )
    .all() as { query: string }[];

  return rows
    .filter((r) => {
      const terms = r.query.toLowerCase().split(/\s+/);
      return queryTerms.some((qt) => terms.includes(qt));
    })
    .map((r) => r.query)
    .slice(0, 5);
}

function getExistingSlugs(): Set<string> {
  const db = getDb();
  return new Set(
    (db.prepare("SELECT slug FROM articles").all() as { slug: string }[]).map(
      (r) => r.slug
    )
  );
}

function getExistingArticlesForLinking(): Array<{ slug: string; title: string }> {
  const db = getDb();
  return db.prepare("SELECT slug, title FROM articles WHERE status = 'published' ORDER BY published_at DESC LIMIT 30")
    .all() as Array<{ slug: string; title: string }>;
}

function logSync(action: string, count: number, status: string) {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_log (id, action, items_count, status) VALUES (?, ?, ?, ?)"
  ).run(nanoid(), action, count, status);
}

/**
 * Write the finished content and flags, and move the article out of 'draft'.
 *
 * The status only changes while the row is still 'draft', i.e. still the
 * generator's own. Setting it unconditionally pulled an article that had been
 * published mid-generation (thumbnail still rendering) back to draft/review,
 * and the next sync then removed it from the live site.
 */
export function finalizeArticle(
  db: ReturnType<typeof getDb>,
  articleId: string,
  content: string,
  status: "draft" | "review",
  flags: Record<string, unknown>
): void {
  db.prepare(
    `UPDATE articles
       SET content = ?, flags = ?,
           status = CASE WHEN status = 'draft' THEN ? ELSE status END
     WHERE id = ?`
  ).run(content, JSON.stringify(flags), status, articleId);
}

/**
 * Record a failed generation and mark its topic used, so it does not block the
 * queue. Returns the new row's id.
 *
 * The row gets a slug of its own rather than the topic's. `slug` is UNIQUE:
 * reusing the topic's slug threw whenever an article already held it (or the
 * same topic failed twice), the queue did not catch it, and Node exits on an
 * unhandled rejection — one failed generation took down the server. Holding the
 * topic's real slug would also push a later successful retry onto a suffixed
 * URL.
 */
export function insertFailedArticle(
  db: ReturnType<typeof getDb>,
  keywordId: string,
  query: string,
  message: string
): string {
  const articleId = nanoid();
  db.prepare(
    `INSERT INTO articles (id, keyword_id, title, slug, category, summary, content, schema_jsonld, status, flags)
     VALUES (?, ?, ?, ?, '', '', '', '', 'generation_failed', ?)`
  ).run(articleId, keywordId, `Failed: ${query}`, `failed-${articleId}`, JSON.stringify({ error: message }));
  db.prepare("UPDATE keywords SET status = 'generated' WHERE id = ?").run(keywordId);
  return articleId;
}
