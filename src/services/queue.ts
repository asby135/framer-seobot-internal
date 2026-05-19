import PQueue from "p-queue";
import { generateArticle } from "./generator.js";
import { translateArticle } from "./translator.js";
import { logger } from "../lib/logger.js";

interface GenerationJob {
  keywordId: string;
  query: string;
}

interface TranslationJob {
  articleId: string;
  force: boolean;
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
 * Enqueue an article generation job.
 * Returns immediately — generation happens in the background.
 */
export function enqueueGeneration(job: GenerationJob): void {
  generationQueue.add(async () => {
    logger.info({ keywordId: job.keywordId, query: job.query }, "Generation starting");

    const result = await generateArticle(job.keywordId, job.query);

    lastGenerationResult = {
      articleId: result.articleId,
      status: result.status,
      query: job.query,
    };

    logger.info(
      { articleId: result.articleId, status: result.status, query: job.query },
      "Generation complete"
    );
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
    } catch (e) {
      lastTranslationResult = { articleId: job.articleId, status: "failed" };
      logger.error(
        { articleId: job.articleId, error: e instanceof Error ? e.message : "unknown" },
        "Translation failed"
      );
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
