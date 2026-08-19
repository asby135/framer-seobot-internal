import type { CallbackHandlers } from "../routes/telegram.js";
import { logger } from "../lib/logger.js";

/**
 * The two approval gates, as callback handlers.
 *
 * Every handler is idempotent: Telegram delivers a callback per tap, and a
 * double-tap or a retried delivery must not generate twice or publish twice.
 * Idempotency is enforced by re-reading current state, never by in-memory
 * flags — the service restarts, the database does not.
 */

export interface KeywordRow {
  id: string;
  query: string;
  status: string;
  proposed_title: string | null;
}

export interface ArticleRow {
  id: string;
  title: string;
  slug: string;
  status: string;
  content: string | null;
}

export interface GateDeps {
  getKeyword(id: string): KeywordRow | undefined;
  approveKeyword(id: string): void;
  rejectKeyword(id: string): void;
  enqueueGeneration(job: { keywordId: string; query: string; titleOverride?: string }): void;

  getArticle(id: string): ArticleRow | undefined;
  /** Returns false when the article was not in a publishable state. */
  publishArticle(id: string): boolean;
  deleteArticle(id: string): void;
  regenerateArticle(id: string): void;

  syncToFramer(): Promise<{ synced: number; removed: number; withLocales: boolean }>;
  schedulePublish(): void;
  /** Revert a publish when the subsequent sync fails, so a retry can work. */
  unpublishArticle(id: string): void;

  /** Keyword ids still pending with a proposed title — for Approve all. */
  pendingProposedKeywordIds(): string[];
  /** Article ids sitting in review — for Publish all. */
  reviewArticleIds(): string[];

  recentTitles(): string[];
  proposeTitle(topic: string, recent: string[], rejected: string[]): Promise<string>;
  saveProposedTitle(keywordId: string, title: string): void;

  editMessage(messageId: number, text: string): Promise<void>;
  alert(message: string): Promise<void>;
}

export function createGateHandlers(deps: GateDeps): CallbackHandlers {
  const handlers: CallbackHandlers = {
    async onApproveTitle(keywordId) {
      const kw = deps.getKeyword(keywordId);
      if (!kw) {
        logger.warn({ keywordId }, "Approve title: unknown keyword");
        return;
      }
      // Idempotency: only a still-pending keyword may enter generation.
      if (kw.status !== "pending") {
        logger.info({ keywordId, status: kw.status }, "Approve title: already actioned");
        return;
      }

      deps.approveKeyword(keywordId);
      deps.enqueueGeneration({
        keywordId,
        query: kw.query,
        titleOverride: kw.proposed_title ?? undefined,
      });
      logger.info({ keywordId, title: kw.proposed_title }, "Title approved — generation enqueued");
    },

    async onRerollTitle(keywordId) {
      const kw = deps.getKeyword(keywordId);
      if (!kw || kw.status !== "pending") return;

      const rejected = kw.proposed_title ? [kw.proposed_title] : [];
      const next = await deps.proposeTitle(kw.query, deps.recentTitles(), rejected);
      deps.saveProposedTitle(keywordId, next);
      logger.info({ keywordId, from: kw.proposed_title, to: next }, "Title rerolled");
    },

    async onRejectTopic(keywordId) {
      const kw = deps.getKeyword(keywordId);
      if (!kw || kw.status !== "pending") return;
      deps.rejectKeyword(keywordId);
    },

    async onPublish(articleId) {
      // publishArticle returns false when the article is not in draft/review,
      // which is what makes a double-tap safe.
      if (!deps.publishArticle(articleId)) {
        logger.info({ articleId }, "Publish: article not in a publishable state");
        return;
      }

      try {
        const result = await deps.syncToFramer();
        logger.info({ articleId, ...result }, "Synced to Framer");
        if (!result.withLocales) {
          await deps.alert(`Synced ${articleId} WITHOUT translations — RU is missing on the site.`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        logger.error({ articleId, error: message }, "Framer sync failed after publish");

        // Roll the publish back. Without this the article is stuck: it reads
        // as published so a second tap is a no-op, but it never reached
        // Framer, and the only recovery is a manual API call.
        deps.unpublishArticle(articleId);

        // Deliberately do NOT arm the deploy: publishing the site after a
        // failed sync would ship a site missing the article just approved, and
        // the guards throw precisely when something is wrong.
        await deps.alert(`Framer sync failed for ${articleId}: ${message} — publish reverted, tap Publish to retry.`);
        return;
      }

      deps.schedulePublish();
    },

    async onRegenerate(articleId) {
      const article = deps.getArticle(articleId);
      // Idempotency: only an unpublished article may be regenerated. Without
      // this a double-tap runs two full generations, and the second collides
      // on the unique slug and lands as generation_failed.
      if (!article || !["draft", "review"].includes(article.status)) {
        logger.info({ articleId, status: article?.status }, "Regenerate: not in a regenerable state");
        return;
      }
      deps.regenerateArticle(articleId);
    },

    async onDelete(articleId) {
      const article = deps.getArticle(articleId);
      if (!article || !["draft", "review", "generation_failed"].includes(article.status)) {
        logger.info({ articleId, status: article?.status }, "Delete: not in a deletable state");
        return;
      }
      deps.deleteArticle(articleId);
    },

    async onApproveAll() {
      const ids = deps.pendingProposedKeywordIds();
      logger.info({ count: ids.length }, "Approve-all requested");
      for (const id of ids) {
        // Reuse the single-item path so the same idempotency and pinning rules
        // apply. A bulk button that took a different code path would drift.
        await handlers.onApproveTitle(id, 0);
      }
    },

    async onPublishAll() {
      const ids = deps.reviewArticleIds();
      logger.info({ count: ids.length }, "Publish-all requested");
      for (const id of ids) {
        await handlers.onPublish(id, 0);
      }
    },
  };

  return handlers;
}
