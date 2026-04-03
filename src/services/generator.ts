import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { searchKB } from "./kb.js";
import { generateThumbnail, processScreenshots } from "./assets.js";
import { queryToSlug } from "../lib/utils.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

interface GeneratedArticle {
  title: string;
  slug: string;
  category: string;
  summary: string;
  content: string; // HTML
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
      `INSERT INTO articles (id, keyword_id, title, slug, category, summary, content, status, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', '{}')`
    ).run(
      articleId,
      keywordId,
      article.title,
      article.slug,
      article.category,
      article.summary,
      article.content
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
      `INSERT INTO articles (id, keyword_id, title, slug, category, summary, content, status, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'generation_failed', ?)`
    ).run(
      articleId,
      keywordId,
      `Failed: ${query}`,
      queryToSlug(query),
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

  const relatedContext =
    relatedQueries.length > 0
      ? `\nRelated search queries people also search: ${relatedQueries.join(", ")}`
      : "";

  const existingArticlesList =
    existingArticles.length > 0
      ? `\nExisting blog articles you can link to using <a href="/blog/slug">:
${existingArticles.map((a) => `- /blog/${a.slug} — "${a.title}"`).join("\n")}`
      : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: `You write blog articles for CRMChat — a Telegram-based CRM and outreach platform for sales teams.

VOICE & TONE:
- Write like you're explaining something to a smart friend over coffee — friendly, direct, no fluff
- Use "you" and "your" constantly. Never "one should" or "businesses can leverage"
- Short sentences. Short paragraphs (2-3 sentences max). People scan, not read
- Be opinionated — take a stance, share what actually works vs. what doesn't
- Use real examples and specific numbers when possible, not vague claims
- Light humor is fine but keep it universal — no cultural jokes, puns, or idioms that break when translated to Russian, Ukrainian, or French
- Skip the generic intro ("In today's fast-paced world..."). Start with the problem or a bold statement
- No filler paragraphs. Every section must teach something or move the reader forward
- End with a clear, actionable takeaway — not a fluffy summary

SEO RULES:
- Include the target keyword naturally in the title, first paragraph, and at least one <h2>
- Write a meta description (summary) under 155 chars that makes people want to click
- Title should be specific and benefit-driven, not generic
- NEVER use these overused title patterns: "Complete Guide", "Ultimate Guide", "Comprehensive Guide", "Everything You Need to Know", "A Deep Dive"
- Good titles: "How to Parse Telegram Groups for Sales Leads", "5 Ways to Avoid Telegram Bans During Outreach", "Telegram CRM: Why Your Sales Team Needs One"
- Bad titles: "The Complete Guide to Telegram Parsing", "Everything You Need to Know About Telegram Outreach"
- Use the target keyword 3-5 times total — never force it. If it reads awkwardly, rephrase

CRMChat MENTIONS:
- Only mention CRMChat where it genuinely fits the topic. 1-2 natural mentions max
- Never write an ad disguised as an article. The article should be useful even without CRMChat
- If the knowledge base has relevant features, reference them with specifics (feature names, what they do)
- Do NOT invent features, pricing, or capabilities not in the knowledge base

ARTICLE LENGTH:
- Target 1,000-1,500 words. Tight, scannable, no padding
- If you can say it in 1,000 words, do. Don't stretch to fill space
- Use bullet points and numbered lists liberally — they're easier to read than paragraphs
- 4-6 <h2> sections is the sweet spot

You MUST respond with valid JSON matching this exact structure:
{
  "title": "SEO-optimized article title (include target keyword)",
  "slug": "url-friendly-slug",
  "category": "one of: outreach, crm, telegram, sales, automation, guides",
  "summary": "1-2 sentence meta description for SEO (under 155 chars)",
  "content": "Full HTML article body"
}

HTML FORMAT:
- <h2> for main sections, <h3> for subsections
- <p> for paragraphs, <ul>/<ol> + <li> for lists, <strong> for emphasis
- <a href="/blog/slug"> for internal links to related existing articles (ONLY use slugs from the list provided — link 2-4 related articles naturally within the text)
- <!-- screenshot:https://example.com --> where a competitor screenshot would add value`,
    messages: [
      {
        role: "user",
        content: `Target keyword: "${query}"
${kbContext ? `\nCRMChat knowledge base (use for accuracy — do NOT invent features):\n${kbContext}` : ""}
${relatedContext}
${existingArticlesList}

Respond with valid JSON only. No markdown fences, no preamble.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Parse the JSON response, stripping any markdown fences
  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  let parsed: GeneratedArticle;
  try {
    parsed = JSON.parse(cleaned) as GeneratedArticle;
  } catch {
    logger.error({ text: cleaned.slice(0, 200) }, "Claude returned invalid JSON");
    throw new Error("Claude returned invalid JSON response");
  }

  // Ensure slug doesn't collide with existing articles
  let slug = queryToSlug(parsed.slug || parsed.title);
  if (existingSlugs.has(slug)) {
    slug = `${slug}-${nanoid(6)}`;
  }

  // Sanitize HTML content
  const sanitizedContent = sanitizeHTML(parsed.content || "");

  return {
    title: parsed.title,
    slug,
    category: parsed.category || "guides",
    summary: parsed.summary || "",
    content: sanitizedContent,
  };
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
