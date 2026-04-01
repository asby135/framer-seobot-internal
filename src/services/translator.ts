import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const LOCALES = ["ru", "ua", "fr"] as const;
type Locale = (typeof LOCALES)[number];

const LOCALE_NAMES: Record<Locale, string> = {
  ru: "Russian",
  ua: "Ukrainian",
  fr: "French",
};

interface TranslationResult {
  title: string;
  slug: string;
  summary: string;
  content: string;
}

/**
 * Translate an article into all configured locales.
 * Skips locales that already have translations unless force=true.
 */
export async function translateArticle(
  articleId: string,
  force: boolean = false
): Promise<{ translated: string[]; skipped: string[]; failed: string[] }> {
  const db = getDb();

  const article = db
    .prepare("SELECT title, summary, content FROM articles WHERE id = ?")
    .get(articleId) as { title: string; summary: string; content: string } | undefined;

  if (!article) {
    throw new Error("Article not found");
  }

  const existing = new Set(
    (
      db
        .prepare("SELECT locale FROM article_translations WHERE article_id = ?")
        .all(articleId) as { locale: string }[]
    ).map((r) => r.locale)
  );

  const translated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const locale of LOCALES) {
    if (!force && existing.has(locale)) {
      skipped.push(locale);
      continue;
    }

    try {
      const result = await callTranslation(article, locale);

      db.prepare(
        `INSERT INTO article_translations (id, article_id, locale, title, slug, summary, content)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(article_id, locale) DO UPDATE SET
           title = excluded.title,
           slug = excluded.slug,
           summary = excluded.summary,
           content = excluded.content`
      ).run(nanoid(), articleId, locale, result.title, result.slug, result.summary, result.content);

      translated.push(locale);
      logger.info({ articleId, locale }, "Article translated");
    } catch (e) {
      logger.error(
        { articleId, locale, error: e instanceof Error ? e.message : "unknown" },
        "Translation failed"
      );
      failed.push(locale);
    }
  }

  return { translated, skipped, failed };
}

async function callTranslation(
  article: { title: string; summary: string; content: string },
  locale: Locale
): Promise<TranslationResult> {
  const langName = LOCALE_NAMES[locale];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: `You are a professional translator specializing in marketing and tech content.
Translate the provided article into ${langName}.

Rules:
- Translate naturally, not word-for-word. The result should read like it was originally written in ${langName}.
- Keep brand names (CRMChat, Telegram) unchanged.
- Preserve all HTML tags and structure exactly — only translate the text content.
- Keep URLs, links, and code blocks unchanged.
- For technical terms with no common ${langName} equivalent, use the English term.
- Maintain the same tone: friendly and direct, like explaining to a friend.

Slug rules:
- Generate a URL-friendly slug for the translated title
- For Russian and Ukrainian: use transliteration (Cyrillic → Latin letters). Example: "как парсить телеграм группы" → "kak-parsit-telegram-gruppy"
- For French: use the French words directly (already Latin script). Example: "comment analyser les groupes telegram" → "comment-analyser-groupes-telegram"
- Lowercase, hyphens only, no special characters, max 60 chars

Respond with valid JSON:
{
  "title": "translated title",
  "slug": "transliterated-or-translated-slug",
  "summary": "translated summary/meta description",
  "content": "translated HTML content"
}`,
    messages: [
      {
        role: "user",
        content: `Translate this article into ${langName}:

TITLE: ${article.title}

SUMMARY: ${article.summary}

CONTENT:
${article.content}

Respond with JSON only, no markdown fences.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    // Remove control characters that break JSON parsing (except \n, \r, \t)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  try {
    return JSON.parse(cleaned) as TranslationResult;
  } catch {
    // Try to extract JSON
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as TranslationResult;
    }
    throw new Error(`Translation returned invalid JSON for ${locale}`);
  }
}

export { LOCALES, type Locale };
