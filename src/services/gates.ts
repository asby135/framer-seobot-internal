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

  recentTitles(): string[];
  proposeTitle(topic: string, recent: string[], rejected: string[]): Promise<string>;
  saveProposedTitle(keywordId: string, title: string): void;

  editMessage(messageId: number, text: string): Promise<void>;
  alert(message: string): Promise<void>;
}

export function createGateHandlers(deps: GateDeps): CallbackHandlers {
  return {
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
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        logger.error({ articleId, error: message }, "Framer sync failed after publish");
        // Deliberately do NOT arm the deploy: publishing the site after a
        // failed sync would ship a site missing the article that was just
        // approved, and the guards throw precisely when something is wrong.
        await deps.alert(`Framer sync failed for ${articleId}: ${message}`);
        return;
      }

      deps.schedulePublish();
    },

    async onRegenerate(articleId) {
      if (!deps.getArticle(articleId)) return;
      deps.regenerateArticle(articleId);
    },

    async onDelete(articleId) {
      if (!deps.getArticle(articleId)) return;
      deps.deleteArticle(articleId);
    },

    async onApproveAll() {
      logger.info("Approve-all requested");
      // Bulk actions are fanned out by the caller, which holds the digest's
      // item list; this handler exists so the callback is not silently dropped.
    },

    async onPublishAll() {
      logger.info("Publish-all requested");
    },
  };
}
