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

// Terms that must be translated consistently across all articles
const GLOSSARY: Array<{ en: string; ru: string; ua: string; fr: string }> = [
  { en: "Account warmup", ru: "Прогрев аккаунтов", ua: "Прогрів акаунтів", fr: "Warm-up de compte" },
  { en: "Automation", ru: "Автоматизация", ua: "Автоматизація", fr: "Automatisation" },
  { en: "Bot", ru: "Бот", ua: "Бот", fr: "Bot" },
  { en: "Broadcast", ru: "Рассылка", ua: "Розсилка", fr: "Diffusion" },
  { en: "Contact", ru: "Контакт", ua: "Контакт", fr: "Contact" },
  { en: "CRM", ru: "CRM", ua: "CRM", fr: "CRM" },
  { en: "CRMChat", ru: "CRMChat", ua: "CRMChat", fr: "CRMChat" },
  { en: "Dashboard", ru: "Дашборд", ua: "Дашборд", fr: "Tableau de bord" },
  { en: "Deal", ru: "Сделка", ua: "Угода", fr: "Deal" },
  { en: "Funnel", ru: "Воронка", ua: "Воронка", fr: "Tunnel" },
  { en: "Lead", ru: "Лид", ua: "Лід", fr: "Lead" },
  { en: "Mini App", ru: "Мини-приложение", ua: "Міні-застосунок", fr: "Mini App" },
  { en: "Onboarding", ru: "Онбординг", ua: "Онбординг", fr: "Onboarding" },
  { en: "Outreach", ru: "Аутрич", ua: "Аутріч", fr: "Prospection" },
  { en: "Parsing", ru: "Парсинг", ua: "Парсинг", fr: "Parsing" },
  { en: "Pipeline", ru: "Пайплайн", ua: "Пайплайн", fr: "Pipeline" },
  { en: "Sequence", ru: "Последовательность", ua: "Послідовність", fr: "Séquence" },
  { en: "Tag", ru: "Тег", ua: "Тег", fr: "Tag" },
  { en: "Telegram Ads", ru: "Telegram Ads", ua: "Telegram Ads", fr: "Telegram Ads" },
  { en: "Template", ru: "Шаблон", ua: "Шаблон", fr: "Modèle" },
  { en: "Warmup", ru: "Прогрев", ua: "Прогрів", fr: "Warm-up" },
  { en: "Workspace", ru: "Рабочее пространство", ua: "Робочий простір", fr: "Espace de travail" },
  { en: "Spintax", ru: "Спинтакс", ua: "Спінтакс", fr: "Spintax" },
  { en: "lead generation", ru: "лидогенерация", ua: "лідогенерація", fr: "génération de leads" },
];

interface TranslationResult {
  title: string;
  slug: string;
  summary: string;
  content: string;
}

// Guard against concurrent translations of the same article
const translatingArticles = new Set<string>();

/**
 * Translate an article into all configured locales.
 * Skips locales that already have translations unless force=true.
 */
export async function translateArticle(
  articleId: string,
  force: boolean = false
): Promise<{ translated: string[]; skipped: string[]; failed: string[] }> {
  if (translatingArticles.has(articleId)) {
    logger.warn({ articleId }, "Translation already in progress, skipping");
    return { translated: [], skipped: [], failed: [] };
  }
  translatingArticles.add(articleId);

  try {
    return await doTranslateArticle(articleId, force);
  } finally {
    translatingArticles.delete(articleId);
  }
}

async function doTranslateArticle(
  articleId: string,
  force: boolean
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

  const glossaryLines = GLOSSARY
    .map((g) => `${g.en} = ${g[locale]}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 32768,
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
        content: `Translate this article into ${langName}.

Use these exact translations for these terms:
${glossaryLines}

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
  const stopReason = response.stop_reason;

  if (stopReason === "max_tokens") {
    logger.warn({ locale, textLength: text.length }, "Translation hit max_tokens limit — response truncated");
  }

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    // Remove control characters that break JSON parsing (except \n, \r, \t)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  try {
    const result = JSON.parse(cleaned) as TranslationResult;
    result.slug = sanitizeSlug(result.slug || "");
    return result;
  } catch {
    // Try to extract JSON
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const result = JSON.parse(match[0]) as TranslationResult;
        result.slug = sanitizeSlug(result.slug || "");
        return result;
      } catch { /* fall through */ }
    }
    logger.error({ locale, stopReason, responseLength: text.length, first500: text.slice(0, 500) }, "Translation returned invalid JSON");
    throw new Error(`Translation returned invalid JSON for ${locale}`);
  }
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export { LOCALES, type Locale };
