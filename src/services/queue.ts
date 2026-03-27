import PQueue from "p-queue";
import { generateArticle } from "./generator.js";
import { logger } from "../lib/logger.js";

interface QueueJob {
  keywordId: string;
  query: string;
}

interface QueueStatus {
  pending: number;
  active: number;
  lastResult: {
    articleId: string;
    status: string;
    query: string;
  } | null;
}

// Single-concurrency queue — one article at a time
const queue = new PQueue({ concurrency: 1 });

let lastResult: QueueStatus["lastResult"] = null;

/**
 * Enqueue an article generation job.
 * Returns immediately — generation happens in the background.
 */
export function enqueueGeneration(job: QueueJob): void {
  queue.add(async () => {
    logger.info({ keywordId: job.keywordId, query: job.query }, "Generation starting");

    const result = await generateArticle(job.keywordId, job.query);

    lastResult = {
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

export function getQueueStatus(): QueueStatus {
  return {
    pending: queue.pending,
    active: queue.size,
    lastResult,
  };
}
