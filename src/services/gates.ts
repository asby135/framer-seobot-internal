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
  /** False when the topic already has a generation job (see queue.ts). */
  enqueueGeneration(job: { keywordId: string; query: string; titleOverride?: string }): boolean;

  getArticle(id: string): ArticleRow | undefined;
  /** Returns false when the article was not in a publishable state. */
  publishArticle(id: string): boolean;
  deleteArticle(id: string): void;
  regenerateArticle(id: string): void;

  syncToFramer(): Promise<{ synced: number; removed: number; withLocales: boolean }>;
  schedulePublish(): void;
  /** Revert a publish when the subsequent sync fails, so a retry can work. */
  unpublishArticle(id: string): void;
  /** The database clock, in the format framer_sync_state.synced_at uses. */
  syncClock(): string;
  /** Of `ids`, those written to Framer at or after `since` (see articlesSyncedSince). */
  syncedSince(ids: string[], since: string): string[];

  /** Keyword ids still pending with a proposed title — for Approve all. */
  pendingProposedKeywordIds(): string[];
  /** Article ids sitting in review — for Publish all. */
  reviewArticleIds(): string[];

  recentTitles(): string[];
  proposeTitle(topic: string, recent: string[], rejected: string[]): Promise<string>;
  saveProposedTitle(keywordId: string, title: string): void;

  editMessage(messageId: number, text: string): Promise<void>;
  alert(message: string): Promise<void>;
  /**
   * Plain progress message, distinct from alert() so a normal acknowledgement
   * does not arrive dressed as a warning.
   *
   * Every gate action takes seconds to minutes — generation, translation, a
   * Framer sync. Without this the operator taps a button and sees nothing at
   * all until the result lands, which is indistinguishable from a broken bot.
   */
  progress(message: string): Promise<void>;
}

export function createGateHandlers(deps: GateDeps): CallbackHandlers {
  /**
   * `quiet` suppresses the per-item acknowledgement so the bulk handlers can
   * send one summary instead of one message per article.
   */
  const approveOne = async (keywordId: string, quiet: boolean): Promise<boolean> => {
    const kw = deps.getKeyword(keywordId);
    if (!kw) {
      logger.warn({ keywordId }, "Approve title: unknown keyword");
      return false;
    }
    // Idempotency: only a still-pending keyword may enter generation.
    if (kw.status !== "pending") {
      logger.info({ keywordId, status: kw.status }, "Approve title: already actioned");
      return false;
    }

    deps.approveKeyword(keywordId);
    const queued = deps.enqueueGeneration({
      keywordId,
      query: kw.query,
      titleOverride: kw.proposed_title ?? undefined,
    });
    if (!queued) {
      // Already being written (e.g. queued from the plugin). Saying "writing"
      // would promise a second article that is not coming.
      logger.info({ keywordId }, "Approve title: topic already has a generation job");
      if (!quiet) {
        await deps.progress(`⏳ “${kw.proposed_title ?? kw.query}” is already being written — the draft arrives here when it is done.`);
      }
      return false;
    }
    logger.info({ keywordId, title: kw.proposed_title }, "Title approved — generation enqueued");
    if (!quiet) {
      await deps.progress(
        `✅ Approved — writing “${kw.proposed_title ?? kw.query}”. The draft arrives here when it and its RU translation are done.`
      );
    }
    return true;
  };

  /**
   * After a failed sync: keep published what reached Framer, roll back the
   * rest, and deploy if anything landed.
   *
   * The sync writes in batches and records each batch as it lands, so a
   * failure partway leaves some articles in Framer. Rolling all of them back
   * left those items in the project while the database said 'review': a
   * deploy before the next sync shipped them, and the next sync then removed
   * them. Rolling back is still right for what did not land — an article left
   * 'published' but absent from Framer is stuck, since a second tap is a no-op.
   */
  const settleFailedSync = (marked: string[], since: string) => {
    const landedSet = new Set(deps.syncedSince(marked, since));
    const landed = marked.filter((id) => landedSet.has(id));
    const reverted = marked.filter((id) => !landedSet.has(id));
    for (const id of reverted) deps.unpublishArticle(id);
    if (landed.length > 0) deps.schedulePublish();
    return { landed, reverted };
  };

  const handlers: CallbackHandlers = {
    async onApproveTitle(keywordId) {
      await approveOne(keywordId, false);
    },

    async onRerollTitle(keywordId) {
      const kw = deps.getKeyword(keywordId);
      if (!kw || kw.status !== "pending") return;

      const rejected = kw.proposed_title ? [kw.proposed_title] : [];
      await deps.progress(`🔄 Rewriting “${kw.proposed_title ?? kw.query}”…`);

      const next = await deps.proposeTitle(kw.query, deps.recentTitles(), rejected);
      deps.saveProposedTitle(keywordId, next);
      logger.info({ keywordId, from: kw.proposed_title, to: next }, "Title rerolled");
      // The new title only ever reached the log, so a reroll silently changed
      // what would be written and the operator approved a headline they had
      // never seen.
      await deps.progress(`🔄 New title: “${next}”\n\nApprove it with the ✅ button above.`);
    },

    async onRejectTopic(keywordId) {
      const kw = deps.getKeyword(keywordId);
      if (!kw || kw.status !== "pending") return;
      deps.rejectKeyword(keywordId);
      await deps.progress(`❌ Rejected “${kw.proposed_title ?? kw.query}”. It will not be proposed again.`);
    },

    async onPublish(articleId) {
      const article = deps.getArticle(articleId);
      // publishArticle returns false when the article is not in draft/review,
      // which is what makes a double-tap safe.
      if (!deps.publishArticle(articleId)) {
        logger.info({ articleId }, "Publish: article not in a publishable state");
        return;
      }
      // Read right after marking, before the Telegram round-trip below: a sync
      // already running can pick the article up and write it in that window,
      // and a later read would make that write look older than this sync.
      const since = deps.syncClock();

      await deps.progress(
        `🚀 Publishing “${article?.title ?? articleId}” — syncing to Framer, then the site deploys within ~5 minutes.`
      );

      try {
        const result = await deps.syncToFramer();
        logger.info({ articleId, ...result }, "Synced to Framer");
        if (!result.withLocales) {
          await deps.alert(`Synced ${articleId} WITHOUT translations — RU is missing on the site.`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        logger.error({ articleId, error: message }, "Framer sync failed after publish");

        // The deploy is armed only if the article itself reached Framer —
        // never to ship a site missing the article just approved.
        const { landed } = settleFailedSync([articleId], since);
        await deps.alert(
          landed.length > 0
            ? `“${article?.title ?? articleId}” reached Framer and will deploy, but the sync then failed: ${message}`
            : `Framer sync failed for ${articleId}: ${message} — publish reverted, tap Publish to retry.`
        );
        return;
      }

      deps.schedulePublish();
    },

    async onRegenerate(articleId) {
      const article = deps.getArticle(articleId);
      if (article && ["draft", "review"].includes(article.status)) {
        await deps.progress(`🔄 Regenerating “${article.title}” from scratch — this takes a few minutes.`);
      }
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
      // A bulk button that quietly does nothing reads as a broken bot. Say why:
      // an empty list means every title in the digest has already been decided,
      // or the digest predates the code that records them.
      if (ids.length === 0) {
        await deps.alert(
          "Approve all: nothing left to approve in the latest digest. Either every title has already been approved or rejected, or this digest predates title recording — approve them individually."
        );
        return;
      }
      // One summary, not one message per title. Generation is serialised, so
      // say that plainly rather than implying all of them start at once.
      await deps.progress(
        `✅ Approving ${ids.length} title${ids.length === 1 ? "" : "s"} — they generate one at a time and each arrives here when ready.`
      );

      let approved = 0;
      for (const id of ids) {
        // Reuse the single-item path so the same idempotency and pinning rules
        // apply. A bulk button that took a different code path would drift.
        if (await approveOne(id, true)) approved++;
      }
      logger.info({ requested: ids.length, approved }, "Approve-all complete");
    },

    async onPublishAll() {
      const ids = deps.reviewArticleIds();
      logger.info({ count: ids.length }, "Publish-all requested");
      if (ids.length === 0) {
        await deps.alert("Publish all: no articles are waiting in review.");
        return;
      }

      await deps.progress(
        `🚀 Publishing ${ids.length} article${ids.length === 1 ? "" : "s"} — syncing each to Framer, then one site deploy covers them all.`
      );

      // Mark everything first, then sync ONCE. Syncing per article opened a new
      // Framer connection each time, and Framer's session takes about 70s to
      // accept its first write after connecting — so 26 articles paid that
      // warm-up 26 times, some 50 minutes for what is a single batch of writes.
      // One sync pays it once and writes the rest in batches.
      const marked = ids.filter((id) => deps.publishArticle(id));
      if (marked.length === 0) {
        logger.info("Publish-all: nothing was in a publishable state");
        return;
      }

      const since = deps.syncClock();
      try {
        const result = await deps.syncToFramer();
        logger.info({ articles: marked.length, ...result }, "Publish-all synced to Framer");
        if (!result.withLocales) {
          await deps.alert(
            `Synced ${marked.length} article${marked.length === 1 ? "" : "s"} WITHOUT translations — RU is missing on the site.`
          );
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        logger.error({ articles: marked.length, error: message }, "Framer sync failed after publish-all");

        // Only what THIS tap marked is considered, and of that only what did
        // not reach Framer is rolled back.
        const { landed, reverted } = settleFailedSync(marked, since);
        const plural = (n: number) => `${n} article${n === 1 ? "" : "s"}`;
        await deps.alert(
          landed.length === 0
            ? `Publish all failed: ${message} — ${plural(marked.length)} still in review, tap Publish all to retry.`
            : `Publish all partly failed: ${message} — ${landed.length} of ${marked.length} went out; ${reverted.length} still in review, tap Publish all to retry.`
        );
        return;
      }

      deps.schedulePublish();
    },
  };

  return handlers;
}
