import PQueue from "p-queue";
import { generateArticle } from "./generator.js";
import { translateArticle } from "./translator.js";
import { logger } from "../lib/logger.js";

interface GenerationJob {
  keywordId: string;
  query: string;
  /** Headline approved by the operator at gate 1, pinned through generation. */
  titleOverride?: string;
}

interface TranslationJob {
  articleId: string;
  force: boolean;
  /** Set by the autopilot chain so the operator is told the article is ready. */
  notifyWhenReady?: boolean;
}

interface QueueStatus {
  pending: number;
  active: number;
  lastResult: {
    articleId?: string;
    status: string;
    query?: string;
  } | null;
}

// Single-concurrency queues — one job at a time per kind. Generation stays
// serial so title-variety rules (which read the last 30 published titles at
// generation start) see each new title before the next job begins. Translation
// stays serial to keep peak Anthropic in-flight calls bounded.
const generationQueue = new PQueue({ concurrency: 1 });
const translationQueue = new PQueue({ concurrency: 1 });

let lastGenerationResult: QueueStatus["lastResult"] = null;
let lastTranslationResult: QueueStatus["lastResult"] = null;

/**
 * Called once an article has finished generating AND translating, i.e. when it
 * is ready for the operator's second approval gate.
 *
 * A hook rather than a direct import so the queue stays free of any dependency
 * on Telegram, and so tests can observe completion without a bot token.
 */
type ArticleReadyHandler = (articleId: string) => void | Promise<void>;
let onArticleReady: ArticleReadyHandler | null = null;

export function setArticleReadyHandler(handler: ArticleReadyHandler | null): void {
  onArticleReady = handler;
}

async function notifyArticleReady(articleId: string): Promise<void> {
  if (!onArticleReady) return;
  try {
    await onArticleReady(articleId);
  } catch (e) {
    // Never let a notification failure break the queue.
    logger.error(
      { articleId, error: e instanceof Error ? e.message : "unknown" },
      "Article-ready handler failed"
    );
  }
}

/**
 * Enqueue an article generation job.
 * Returns immediately — generation happens in the background.
 */
export function enqueueGeneration(job: GenerationJob): void {
  generationQueue.add(async () => {
    logger.info({ keywordId: job.keywordId, query: job.query }, "Generation starting");

    const result = await generateArticle(job.keywordId, job.query, job.titleOverride);

    lastGenerationResult = {
      articleId: result.articleId,
      status: result.status,
      query: job.query,
    };

    logger.info(
      { articleId: result.articleId, status: result.status, query: job.query },
      "Generation complete"
    );

    // Chain RU translation so an article reaches the review gate already
    // localized. Without this the operator would approve an article that only
    // becomes bilingual after a separate manual trigger.
    //
    // Skipped for generation_failed rows: they have no usable content, and
    // translating a failure stub would waste a call and produce a misleading
    // "translated" flag on the article.
    if (result.status !== "generation_failed") {
      enqueueTranslation({ articleId: result.articleId, force: false, notifyWhenReady: true });
    } else {
      // A failed generation still needs to reach the operator, or the topic
      // vanishes with no article and no message.
      await notifyArticleReady(result.articleId);
    }
  });
}

/**
 * Enqueue an article translation job.
 * Runs after any currently-translating article completes — never in parallel,
 * so peak Anthropic calls stay bounded even when bulk-translating.
 */
export function enqueueTranslation(job: TranslationJob): void {
  translationQueue.add(async () => {
    logger.info({ articleId: job.articleId, force: job.force }, "Translation starting");

    try {
      const result = await translateArticle(job.articleId, job.force);
      lastTranslationResult = { articleId: job.articleId, status: "complete" };
      logger.info(
        { articleId: job.articleId, ...result },
        "Translation complete"
      );
      if (job.notifyWhenReady) await notifyArticleReady(job.articleId);
    } catch (e) {
      lastTranslationResult = { articleId: job.articleId, status: "failed" };
      logger.error(
        { articleId: job.articleId, error: e instanceof Error ? e.message : "unknown" },
        "Translation failed"
      );
      // Still surface the article: an untranslated draft is reviewable, and
      // silently withholding it would strand it in `review` forever.
      if (job.notifyWhenReady) await notifyArticleReady(job.articleId);
    }
  });
}

export function getQueueStatus(): QueueStatus {
  return {
    pending: generationQueue.pending,
    active: generationQueue.size,
    lastResult: lastGenerationResult,
  };
}

export function getTranslationQueueStatus(): QueueStatus {
  return {
    pending: translationQueue.pending,
    active: translationQueue.size,
    lastResult: lastTranslationResult,
  };
}
