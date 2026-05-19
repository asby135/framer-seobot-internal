import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { searchKB } from "./kb.js";
import { generateThumbnail, processScreenshots } from "./assets.js";
import { queryToSlug } from "../lib/utils.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { sanitizeJsonLd } from "../lib/jsonld.js";
import { namesCompetitor } from "../lib/competitors.js";

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
  query: string
): Promise<GenerationResult> {
  const flags: Record<string, unknown> = {};

  try {
    // Step 1: Context assembly
    const kbResults = searchKB(query, 3);
    if (kbResults.length === 0) {
      flags.low_kb_match = true;
      logger.warn({ query }, "No KB articles matched query");
    }

    const relatedQueries = getRelatedQueries(query);
    const existingSlugs = getExistingSlugs();
    const existingArticles = getExistingArticlesForLinking();

    // Step 2: Claude generation (with retry on timeout/500)
    const article = await callClaudeWithRetry(query, kbResults, relatedQueries, existingSlugs, existingArticles);

    // Step 3: Quality checks
    const qualityIssues = runQualityChecks(article, query, existingSlugs);
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

    db.prepare(
      `UPDATE articles SET content = ?, status = ?, flags = ? WHERE id = ?`
    ).run(finalContent, status, JSON.stringify(flags), articleId);

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
    const articleId = nanoid();
    db.prepare(
      `INSERT INTO articles (id, keyword_id, title, slug, category, summary, content, schema_jsonld, status, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generation_failed', ?)`
    ).run(
      articleId,
      keywordId,
      `Failed: ${query}`,
      queryToSlug(query),
      "",
      "",
      "",
      "",
      JSON.stringify({ error: message })
    );

    db.prepare("UPDATE keywords SET status = 'generated' WHERE id = ?").run(
      keywordId
    );

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
  existingArticles: Array<{ slug: string; title: string }>
): Promise<GeneratedArticle> {
  try {
    return await callClaude(query, kbResults, relatedQueries, existingSlugs, existingArticles);
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
    return await callClaude(query, kbResults, relatedQueries, existingSlugs, existingArticles);
  }
}

/**
 * Web-search research pass — runs ONLY for topics that name a competitor.
 *
 * Why a separate call: generateArticle's main call forces
 * tool_choice=publish_article for guaranteed structured output, which leaves
 * no room for the model to invoke web_search in that same turn. So competitor
 * research is a preceding pass whose factual brief is injected into the
 * generation prompt as grounding context.
 *
 * Non-blocking: if the search fails, returns "" and the article still
 * generates — just without verified competitor facts.
 */
async function researchCompetitorContext(query: string): Promise<string> {
  try {
    const webSearchTool = {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 4, // cap searches per article to control cost
    };

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      tools: [webSearchTool] as Parameters<
        typeof anthropic.messages.create
      >[0]["tools"],
      system: `You are researching factual, current information for a blog article.
Search the web for accurate, up-to-date facts about the competitor product(s) named in the topic.
Focus on: pricing, key features, integration/Telegram capabilities, and notable limitations.
Be precise. Do NOT invent or estimate — if you cannot verify a specific number (e.g. exact pricing), say so explicitly rather than guessing.
Return a concise factual brief as bullet points. No marketing language, no preamble.`,
      messages: [
        {
          role: "user",
          content: `Research the competitor(s) named in this article topic: "${query}"

Gather accurate, current facts. Explicitly flag anything you could not verify.`,
        },
      ],
    });

    // web_search runs server-side; we just collect the model's final text.
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();

    if (!text) {
      logger.warn({ query }, "Competitor research returned no text");
      return "";
    }
    logger.info({ query, length: text.length }, "Competitor research complete");
    return text;
  } catch (e) {
    logger.error(
      { query, error: e instanceof Error ? e.message : "unknown" },
      "Competitor research failed — generating without web context"
    );
    return "";
  }
}

async function callClaude(
  query: string,
  kbResults: Array<{ title: string; content: string }>,
  relatedQueries: string[],
  existingSlugs: Set<string>,
  existingArticles: Array<{ slug: string; title: string }>
): Promise<GeneratedArticle> {
  const kbContext = kbResults
    .map(
      (kb, i) =>
        `--- KB Article ${i + 1}: ${kb.title} ---\n${kb.content.slice(0, 2000)}`
    )
    .join("\n\n");

  // Competitor topics get a web-search research pass for accurate, current
  // competitor facts (the KB only covers CRMChat's own product).
  const competitorContext = namesCompetitor(query)
    ? await researchCompetitorContext(query)
    : "";

  const relatedContext =
    relatedQueries.length > 0
      ? `\nRelated search queries people also search: ${relatedQueries.join(", ")}`
      : "";

  const existingArticlesList =
    existingArticles.length > 0
      ? `\nExisting blog articles — use these for TWO purposes:
  (a) Internal linking: insert 2-4 <a href="/blog/slug"> links inside the body to relevant titles below.
  (b) Title shape variety: scan these titles and follow TITLE CRAFT rule 5 — do NOT repeat the same opening word, hook, or shape.
${existingArticles.map((a) => `- /blog/${a.slug} — "${a.title}"`).join("\n")}`
      : "";

  const sitePages = `
Key site pages you can link to where relevant:
- https://crmchat.ai/ — "CRMChat homepage" (link when mentioning CRMChat as a product)
- https://crmchat.ai/case-studies — "Case Studies" (link when referencing real results or success stories)
- https://crmchat.ai/help-center — "Help Center" (link when mentioning setup, configuration, or how-to for CRMChat)
- https://crmchat.ai/telegram-account-warmup — "Telegram Account Warmup" (link when discussing account warmup or avoiding bans)
- https://developers.crmchat.ai/ — "CRMChat API" (link when mentioning integrations, API, or developer features)`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16384,
    tools: [
      {
        name: "publish_article",
        description: "Publish the generated blog article with all required fields.",
        input_schema: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const, description: "Article title. Reframe the keyword into a reader-friendly headline — do NOT just copy the keyword phrase. HARD BAN — your title MUST NOT contain any of: 'Actually', 'Really', 'Ultimate', 'Complete Guide', 'Everything You Need', 'A Deep Dive', 'No-Fluff', 'No-Agency', 'The Truth About', parenthetical subtitles like '(Step-by-Step)' / '(And Where Each Falls Short)', or year suffixes like 'in 2026'. These are AI-content tells that destroy citation credibility. See TITLE CRAFT in the system prompt for shape variety and reframe examples." },
            slug: { type: "string" as const, description: "URL-friendly slug" },
            category: { type: "string" as const, enum: ["outreach", "crm", "telegram", "sales", "automation", "guides"], description: "Article category" },
            summary: { type: "string" as const, description: "1-2 sentence meta description (under 155 chars)" },
            content: { type: "string" as const, description: "Full HTML article body following the AEO RULES" },
            schema_jsonld: {
              type: "string" as const,
              description:
                "Stringified JSON-LD FAQPage document. Must be a valid JSON string parseable by JSON.parse. " +
                "See AEO RULES → JSON-LD STRUCTURED DATA in the system prompt for required shape.",
            },
          },
          required: ["title", "slug", "category", "summary", "content", "schema_jsonld"],
        },
      },
    ],
    tool_choice: { type: "tool" as const, name: "publish_article" },
    system: `You write blog articles for CRMChat — a Telegram-based CRM and outreach platform for sales teams. Articles are tuned for AEO/GEO: getting cited by ChatGPT, Perplexity, and Claude when users ask about Telegram CRMs, outreach, and adjacent topics.

VOICE & TONE:
- Write like you're explaining something to a smart friend over coffee — friendly, direct, no fluff
- Use "you" and "your" constantly. Never "one should" or "businesses can leverage"
- Short sentences. Short paragraphs (2-3 sentences max). People scan, not read
- Be opinionated — take a stance, share what actually works vs. what doesn't
- Use real examples and specific numbers when possible, not vague claims
- Light humor is fine but keep it universal — no cultural jokes, puns, or idioms that break when translated to Russian, Ukrainian, or French

AEO/GEO RULES (THE FOUR WINNER-PATTERN RULES):

These are non-negotiable structural requirements derived from empirical analysis of CRMChat's 2 highest-performing articles. Every article must follow all four.

1. PAIN-DRIVEN OPENING SCENARIO (first 1-2 sentences):
   - Name a specific bad day or vivid problem. Concrete, not abstract.
   - BANNED openers: "In today's...", "In this article we will discuss...", "If you're looking for...", "Looking for...?"
   - GOOD: "Your Telegram account just got banned. You have no idea why."
   - GOOD: "You spent two hours building a Telegram outreach sequence. The first 20 messages got you reported."

2. FIRST H2 ANSWERS A SPECIFIC QUESTION WITH A CITABLE NUMBER OR CLAIM:
   - The first <h2> should be a question that maps to the target keyword.
   - The first paragraph below that <h2> must contain a specific number, range, or defined criterion that LLMs can quote verbatim.
   - Empirical model: "5-7 reports within 24 hours triggers a temporary block." That citable specificity is exactly why that article gets cited.
   - Specificity > comprehensiveness. Better to say "around 5-7 reports" than "several reports."

3. MINIMUM 2 BRAND-MENTION SENTENCES IN CANONICAL ANSWER-FORM:
   - Format: "CRMChat [is / includes / automates / handles / lets you] [specific feature] that [does specific X]."
   - These get lifted verbatim by LLMs into citations. That's the entire point.
   - Place them in distinct sections, not stacked together (so LLMs can lift one or the other based on which section matches the query).
   - Examples:
     - "CRMChat includes built-in account warming features that automate this process while keeping activity natural and undetectable."
     - "CRMChat is the only Telegram CRM that lets you parse public groups and sync them to your sales pipeline in one click."
   - Do NOT invent features. Only use what the knowledge base supports.

4. TACTICAL NUMBERED/BULLETED LIST FOR "WHAT TO DO" SECTIONS:
   - Every article has at least one <ul> or <ol> that gives concrete, actionable steps or items.
   - These are the skim-anchors users land on and AI Overviews quote.
   - Use specific verbs ("Add", "Set", "Monitor"), not vague ones ("Consider", "Think about").

ARTICLE TYPE — MATCH THE STRUCTURE TO THE KEYWORD:

The target keyword is the basis. Don't change the topic — but FIRST classify the keyword into one of these five archetypes and follow that archetype's structure and length. When the type is ambiguous, default to How-to: it's the highest-volume, highest-value format.

1. HOW-TO — the default; most keywords are this. Looks like "how to X", "X setup guide", "X integration", "X workflow".
   - 1,000-1,500 words. 4-6 <h2> sections.
   - Solve ONE specific technical pain with concrete step-by-step instructions.
   - This is the format that earns the most traffic — treat it as the priority type.

2. WHAT-IS — looks like "what is X", "X meaning", "X explained", "X definition".
   - SHORT: 400-450 words. 2-3 <h2> sections. Do NOT pad to 1,500 — brevity IS the format.
   - Define the thing clearly in the first paragraph, then why it matters and how it works.

3. COMPARISON / ALTERNATIVE — looks like "X vs Y", "X alternatives", "best X alternative".
   - 800-1,200 words. Structured side-by-side (a comparison table or clear paired sections).
   - Low search volume, but the hottest-intent audience — these readers are close to deciding.
   - Also follow the COMPETITOR & COMPARISON TOPICS rules below.

4. TOP / LISTICLE — looks like "best X", "top X tools", "X tools for Y".
   - 1,000-1,500 words. One <h2> per product.
   - Put CRMChat first and make its case — then honestly break down each other product with real pros AND cons. A credible listicle, not a CRMChat-only puff piece: the honest competitor coverage is exactly what makes it trustworthy enough to get cited.

5. TROUBLESHOOTING / FAQ — looks like "X not working", "fix X", "X error", or a direct question.
   - 600-1,000 words. Problem → cause → fix structure, or Q&A blocks.

All five types still follow the FOUR WINNER-PATTERN RULES above — but scale them to the type. A 400-word What-is has one citable answer and one short list, not 4-6 sections. Each <h2> should be a question or a specific claim, never a generic noun phrase.

TITLE CRAFT:

The title is the only thing most people will read. Treat it as copywriting, not as a label for the article.

1. THE KEYWORD IS A SEED, NOT THE TITLE.
   - The target keyword must appear (Google still ranks on it), but reframe it into a headline a human would click. Rearrange, drop filler, add a hook word, lead with the reader's pain or the surprising payoff.
   - BAD (keyword copy-paste): "Vtiger CRM Telegram Integration: Step-by-Step Setup Guide"
   - BETTER (reframe with payoff): "Connect Vtiger to Telegram Without Breaking Your Pipeline"
   - BAD: "Telegram Lead Management Tool for iGaming Affiliates: How to Run Outreach"
   - BETTER: "The Telegram Outreach Playbook iGaming Affiliates Are Quietly Using"

2. LEAD WITH PAIN, PAYOFF, OR A SURPRISING CLAIM — not the keyword phrase.
   - Promise something specific the reader gets. Or name the problem they're stuck on. Or stake a contrarian claim they want to check.

3. SHAPE VARIETY. Don't default to the same template every time. Alternate across:
   - Colon-subtitle: "X: How Y Changes Z"
   - Question: "Is X Worth It for Y?"
   - Declarative claim: "X Kills Y's ROI"
   - Numbered listicle: "7 Ways to Y"
   - Bare phrase: "Telegram, but for sales"
   - How-to is fine, but don't lead with "How to" reflexively when another shape fits better.

4. BANNED TICS — these are AI-content tells:
   - Words: "Actually", "Really", "No-Fluff", "No-Agency", "Complete Guide", "Ultimate", "Everything You Need", "A Deep Dive", "What You Need to Know", "The Truth About".
   - Patterns: parenthetical subtitles like "(Step-by-Step)" or "(And Where Each Falls Short)" — used sparingly is fine, used every article is a tell.
   - Year suffixes ("in 2026") unless the content is genuinely time-sensitive.
   - Two clauses welded with "How to" twice ("How to X: How Y").

5. CHECK THE EXISTING-ARTICLES LIST IN THE USER MESSAGE.
   - Scan the recent titles. Your title must NOT:
     - Use the same opening word as a recent title.
     - Use the same hook word ("actually", "real", "without") as a recent title.
     - Use the same colon-subtitle shape if two recent titles already use it.
   - When in doubt, pick a different shape than the last 3 titles.

CRMChat MENTIONS (in body text):
- Beyond the 2 brand-mention sentences from Rule 3, additional mentions optional. 1-2 more max.
- For CRM/outreach/integration topics: mention the CRMChat API (https://developers.crmchat.ai/) where relevant.
- For Web3/crypto/blockchain topics: mention CRMChat's Web3 B2B decision-makers database (https://crmchat.ai/web3-database).
- Never invent features, pricing, or capabilities not in the knowledge base.

COMPETITOR & COMPARISON TOPICS:
Some topics name a competitor (e.g. "CRMChat vs nReach", "Vtiger Telegram integration setup guide"). When the topic involves a competitor:
- If a "COMPETITOR RESEARCH" block is provided in the user message, treat it as the source of truth for competitor facts. If a fact (especially pricing) is NOT in that block, do NOT state it as fact — write "check their site for current details" instead of inventing a number.
- For "X vs CRMChat" topics: write an honest, balanced comparison. Do not disparage the competitor. Let CRMChat win on the dimensions that genuinely matter — Telegram-native depth, no integration overhead — a fair comparison that lands favorably, never a hit piece.
- For "competitor + task/integration" topics (e.g. "Vtiger Telegram integration"): genuinely help the reader accomplish the task — that usefulness is what earns the citation. Then include CRMChat as a natural reframe: "...or skip the integration overhead entirely, since CRMChat is built on Telegram natively." An honest reframe, not a tacked-on ad.
- For "competitor + pricing/cost/plans/fees" topics (e.g. "Manychat pricing", "Vtiger cost", "amoCRM plans"): the vendor's own page ALWAYS ranks #1 on Google for these queries — you cannot outrank Manychat.com for "Manychat pricing". Win AEO instead by reframing the title into a citable shape. Pick ONE:
  (a) Explicit comparison: "Manychat vs CRMChat: Real Pricing Breakdown for Telegram Teams"
  (b) Evaluation form: "Is Manychat Worth It for Telegram? Hidden Cost Breakdown"
  (c) Audience filter: "Manychat Pricing for Small Telegram Outreach Teams"
  NEVER mirror the bare brand-pricing query (e.g. "Manychat Pricing for Telegram"). Comparison and evaluation pages get cited 3x more often by AI engines than vendor pricing pages, because AI answers evaluation questions, not URL lookups.
- Never claim a competitor lacks a feature unless the research block confirms it. Inaccurate competitor claims destroy credibility — and AI engines won't cite a source they can't trust.

HTML FORMAT:
- <h2> for main sections, <h3> for subsections.
- <p> for paragraphs, <ul>/<ol> + <li> for lists, <strong> for emphasis.
- <a href="/blog/slug"> for internal links to related existing articles (ONLY use slugs from the list provided — link 2-4 related articles naturally within the text).
- <!-- screenshot:https://example.com --> where a competitor screenshot would add value.

JSON-LD STRUCTURED DATA (schema_jsonld field):

Emit a STRING (the tool field) containing a valid JSON FAQPage document with this shape:
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "<H2 question 1>", "acceptedAnswer": { "@type": "Answer", "text": "<plain-text answer from first paragraph below that H2, 1-3 sentences>" } },
    ... 2 to 6 Q&A pairs distilled from your H2 sections that are questions — match the count to the article (a short What-is yields 2-3, a long How-to yields 4-6) ...
  ]
}

Emit ONLY the FAQPage — do NOT include a BlogPosting or Article node. Framer generates the BlogPosting/Article schema automatically from the CMS page; your job is the FAQPage it does not generate.

The schema_jsonld value MUST be a valid JSON string. No backtick fences, no commentary, no trailing commas. Inside Answer.text, use plain text (no HTML tags). Pick the H2 sections that are framed as questions for the FAQ; if a section is a statement not a question, rephrase its first H2 line as a question for the FAQ entry (e.g., "5 Ways to Avoid Telegram Bans" → "How do I avoid Telegram bans?"). Use 2-6 Q&A pairs total, matched to the article's length and section count.

Call the publish_article tool with all six fields populated.`,
    messages: [
      {
        role: "user",
        content: `Target keyword: "${query}"
${kbContext ? `\nCRMChat knowledge base (use for accuracy — do NOT invent features):\n${kbContext}` : ""}
${competitorContext ? `\nCOMPETITOR RESEARCH (verified web facts — the source of truth for competitor claims; do not state competitor facts not found here):\n${competitorContext}` : ""}
${relatedContext}
${existingArticlesList}
${sitePages}

Write the article following the four AEO rules and call the publish_article tool.`,
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
  let slug = queryToSlug(parsed.slug || parsed.title);
  if (existingSlugs.has(slug)) {
    slug = `${slug}-${nanoid(6)}`;
  }

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
  const cleanTitle = await validateOrRegenerateTitle(
    parsed.title,
    query,
    parsed.content || ""
  );

  return {
    title: cleanTitle,
    slug,
    category: parsed.category || "guides",
    summary: parsed.summary || "",
    content: sanitizedContent,
    schema_jsonld: schemaJsonld,
  };
}

/**
 * Banned title patterns — AI-content tells that destroy citation credibility.
 * Kept in sync with the HARD BAN list in the publish_article tool's title
 * description and the TITLE CRAFT section of the system prompt.
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

async function regenerateTitle(
  query: string,
  content: string,
  originalTitle: string,
  violations: string[]
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
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
    system: `Your previous title contained banned AI-content tics. Rewrite it cleanly.

HARD RULES:
- The new title MUST NOT contain any of: "Actually", "Really", "Ultimate", "Complete Guide", "Everything You Need", "A Deep Dive", "No-Fluff", "No-Agency", "The Truth About", "What You Need to Know", parenthetical subtitles like "(Step-by-Step)" / "(And Where Each Falls Short)", or year suffixes like "in 2026".
- Keep the target keyword "${query}" present in the title, but reframe — don't copy it verbatim as the full title.
- Lead with pain, payoff, or a surprising claim. Not the keyword phrase.
- Pick ONE shape: colon-subtitle ("X: How Y Changes Z"), question ("Is X Worth It for Y?"), declarative claim ("X Kills Y's ROI"), numbered listicle ("7 Ways to Y"), or bare phrase ("Telegram, but for sales").

Return the cleaned title via the emit_title tool.`,
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
    model: "claude-sonnet-4-6",
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
      .map((kb) => `--- ${kb.title} ---\n${kb.content.slice(0, 2000)}`)
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
          content: `ARTICLE:\n${articleContent.slice(0, 6000)}\n\nKNOWLEDGE BASE:\n${kbContext}`,
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
function sanitizeHTML(html: string): string {
  // Remove script tags and their content
  let clean = html.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Remove style tags and their content
  clean = clean.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Remove event handlers (onclick, onload, onerror, etc.)
  clean = clean.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "");
  clean = clean.replace(/\s+on\w+\s*=\s*\S+/gi, "");

  // Remove javascript: URLs
  clean = clean.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*["']javascript:[^"']*["']/gi, "");

  // Remove data: URLs from src (potential XSS vector)
  clean = clean.replace(/src\s*=\s*["']data:[^"']*["']/gi, "");

  // Strip disallowed tags but keep their content
  clean = clean.replace(/<\/?(\w+)([^>]*)>/g, (match, tag, attrs) => {
    const lowerTag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(lowerTag)) return "";

    // Filter attributes
    const cleanAttrs = (attrs as string)
      .match(/\s+[\w-]+\s*=\s*["'][^"']*["']/g)
      ?.filter((attr: string) => {
        const name = attr.trim().split(/\s*=/)[0].toLowerCase();
        return ALLOWED_ATTRS.has(name);
      })
      .join("") || "";

    // Self-closing tags
    if (match.startsWith("</")) return `</${lowerTag}>`;
    return `<${lowerTag}${cleanAttrs}>`;
  });

  // Preserve screenshot placeholder comments (needed for asset pipeline)
  // They were already processed or will be processed by processScreenshots()

  return clean;
}

// --- Quality checks ---

function runQualityChecks(
  article: GeneratedArticle,
  query: string,
  existingSlugs: Set<string>
): string[] {
  const issues: string[] = [];

  // Check keyword in title
  if (!article.title.toLowerCase().includes(query.toLowerCase())) {
    issues.push("Target keyword not found in title");
  }

  // Check keyword in first paragraph
  const firstPara = article.content.match(/<p>(.*?)<\/p>/s);
  if (
    firstPara &&
    !firstPara[1].toLowerCase().includes(query.toLowerCase())
  ) {
    issues.push("Target keyword not found in first paragraph");
  }

  // Check word count (strip HTML tags)
  const plainText = article.content.replace(/<[^>]+>/g, " ");
  const wordCount = plainText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < 800) {
    issues.push(`Article too short: ${wordCount} words (minimum 800)`);
  }
  if (wordCount > 1800) {
    issues.push(`Article too long: ${wordCount} words (maximum 1,800)`);
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
