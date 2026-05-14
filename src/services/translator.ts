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
  schema_jsonld: string; // JSON-LD with localized headline/description/FAQ (may be empty on failure)
}

/**
 * Minimum-shape validity check for translated schema_jsonld.
 * Mirrors the helper in generator.ts; intentionally duplicated for minimal cross-file coupling.
 */
function isValidJsonLd(raw: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return false;
    if (obj["@context"] !== "https://schema.org") return false;
    if (!obj["@type"] && !obj["@graph"]) return false;
    return true;
  } catch {
    return false;
  }
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
    .prepare("SELECT title, summary, content, schema_jsonld FROM articles WHERE id = ?")
    .get(articleId) as
    | { title: string; summary: string; content: string; schema_jsonld: string | null }
    | undefined;

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

      // Validate translated schema_jsonld; drop if invalid (Framer renders no <script>)
      const validatedSchema = isValidJsonLd(result.schema_jsonld) ? result.schema_jsonld : "";
      if (result.schema_jsonld && !validatedSchema) {
        logger.warn(
          { articleId, locale, preview: result.schema_jsonld.slice(0, 200) },
          "Translated schema_jsonld invalid, dropping"
        );
      }

      db.prepare(
        `INSERT INTO article_translations (id, article_id, locale, title, slug, summary, content, schema_jsonld)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(article_id, locale) DO UPDATE SET
           title = excluded.title,
           slug = excluded.slug,
           summary = excluded.summary,
           content = excluded.content,
           schema_jsonld = excluded.schema_jsonld`
      ).run(nanoid(), articleId, locale, result.title, result.slug, result.summary, result.content, validatedSchema);

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
  article: { title: string; summary: string; content: string; schema_jsonld: string | null },
  locale: Locale
): Promise<TranslationResult> {
  const langName = LOCALE_NAMES[locale];

  const glossaryLines = GLOSSARY
    .map((g) => `"${g.en}" → "${g[locale]}"`)
    .join("\n");

  const hasSchema = !!article.schema_jsonld && article.schema_jsonld.length > 0;
  const schemaBlock = hasSchema
    ? `
SCHEMA_JSONLD (English source — translate the headline, description, articleSection, and FAQPage Question/Answer text into ${langName}; preserve all other fields and structure EXACTLY):
${article.schema_jsonld}
`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
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

Glossary — use these exact translations:
${glossaryLines}

Slug rules:
- Generate a URL-friendly slug for the translated title
- For Russian and Ukrainian: use transliteration (Cyrillic → Latin letters). Example: "как парсить телеграм группы" → "kak-parsit-telegram-gruppy"
- For French: use the French words directly (already Latin script). Example: "comment analyser les groupes telegram" → "comment-analyser-groupes-telegram"
- Lowercase, hyphens only, no special characters, max 60 chars

SCHEMA_JSONLD translation rules (when source is provided):
- Output a JSON STRING (the schema_jsonld field) containing a JSON.stringify-ed JSON-LD document.
- Translate ONLY these fields into ${langName}: BlogPosting.headline, BlogPosting.description, BlogPosting.articleSection, and every FAQPage mainEntity Question.name and Answer.text.
- Preserve ALL other fields and structure exactly as in the source (URLs, @context, @type, datePublished, author, publisher, etc.).
- The schema_jsonld value MUST be a valid JSON string parseable by JSON.parse. No trailing commas, no commentary, no fences.
- Inside Answer.text use plain text only (no HTML).
- If no SCHEMA_JSONLD is provided, return an empty string for the schema_jsonld field.

Respond with valid JSON:
{
  "title": "translated title",
  "slug": "transliterated-or-translated-slug",
  "summary": "translated summary/meta description",
  "content": "translated HTML content",
  "schema_jsonld": "stringified JSON-LD with localized fields (or empty string if no source provided)"
}`,
    messages: [
      {
        role: "user",
        content: `Translate this article into ${langName}:

TITLE: ${article.title}

SUMMARY: ${article.summary}

CONTENT:
${article.content}
${schemaBlock}
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
  } catch (parseError) {
    const parseMsg = parseError instanceof Error ? parseError.message : "unknown";
    logger.warn({ locale, parseError: parseMsg }, "Initial JSON parse failed, trying recovery");

    // Try to extract JSON block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const result = JSON.parse(match[0]) as TranslationResult;
        result.slug = sanitizeSlug(result.slug || "");
        return result;
      } catch { /* fall through */ }
    }

    // Try to extract fields manually as a last resort.
    // schema_jsonld is intentionally NOT recovered here — the recovery path
    // is brittle and schema is optional; we'd rather drop it than corrupt it.
    try {
      const titleMatch = cleaned.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const slugMatch = cleaned.match(/"slug"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const summaryMatch = cleaned.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const contentMatch = cleaned.match(/"content"\s*:\s*"([\s\S]*?)"\s*,\s*"schema_jsonld"/);
      const contentFallbackMatch = contentMatch || cleaned.match(/"content"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);

      if (titleMatch && summaryMatch && contentFallbackMatch) {
        logger.info({ locale }, "Recovered translation via field extraction (schema_jsonld dropped)");
        return {
          title: titleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
          slug: sanitizeSlug(slugMatch?.[1] || ""),
          summary: summaryMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
          content: contentFallbackMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
          schema_jsonld: "",
        };
      }
    } catch { /* fall through */ }

    logger.error({ locale, stopReason, parseError: parseMsg, responseLength: text.length, first500: text.slice(0, 500) }, "Translation returned invalid JSON");
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
