import { nanoid } from "nanoid";
import { connect } from "framer-api";
import { getDb } from "../db/index.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { getSetting, setSetting } from "./settings.js";
import { DEFAULT_NICHES, type Niche } from "./taxonomy.js";
import { seedTopics, getCoveredTopics } from "./seeder.js";
import { proposeTitle } from "./title.js";
import { enqueueGeneration } from "./queue.js";
import { syncToFramer } from "./framer-sync.js";
import { createPublishDebouncer } from "./publish-debounce.js";
import { createRunner, type Runner } from "./scheduler.js";
import { createGateHandlers, type KeywordRow, type ArticleRow } from "./gates.js";
import { runNightly, type TitleProposal } from "./autopilot.js";
import { buildDigest, buildKeyboard, sendMessage, sendDocument, editMessage, alert, escapeHtml } from "./notify.js";
import { setArticleReadyHandler } from "./queue.js";
import type { CallbackHandlers } from "../routes/telegram.js";

/**
 * Assembles the real dependencies for the autopilot.
 *
 * Everything above this file is injected and unit-tested; this is the only
 * place the pieces meet the database, Anthropic, Telegram and Framer.
 */

const PUBLISH_DEBOUNCE_MS = 5 * 60 * 1000;

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Publish the Framer site and deploy to custom domains. */
async function publishFramerSite(): Promise<void> {
  const framer = await connect(env.FRAMER_PROJECT_URL, env.FRAMER_API_KEY);
  try {
    const { deployment } = await framer.publish();
    const hostnames = await framer.deploy(deployment.id);
    logger.info(
      { deploymentId: deployment.id, hostnames: hostnames.length },
      "Framer site published"
    );
  } finally {
    await framer.disconnect();
  }
}

const debouncer = createPublishDebouncer({
  delayMs: PUBLISH_DEBOUNCE_MS,
  publish: async () => {
    await publishFramerSite();
    setSetting("publishPendingSince", null);
  },
  onError: async (message) => {
    // Leave publishPendingSince set so the next boot retries rather than
    // losing the deploy entirely.
    await alert(message);
  },
});

/**
 * Arm the debounced deploy AND record that one is owed.
 *
 * The timer lives in memory, so a Railway redeploy inside the debounce window
 * would otherwise drop it silently: articles published in the database and
 * pushed to Framer, but the site never deployed and nobody told.
 */
function schedulePublishPersisted(): void {
  if (getSetting<string | null>("publishPendingSince", null) === null) {
    setSetting("publishPendingSince", new Date().toISOString());
  }
  debouncer.schedule();
}

/** On boot, re-arm a deploy that was owed when the process last stopped. */
export function recoverPendingPublish(): void {
  const pending = getSetting<string | null>("publishPendingSince", null);
  if (pending === null) return;
  logger.warn({ pendingSince: pending }, "Publish was owed at shutdown — re-arming");
  debouncer.schedule();
}

/** Flush a pending deploy on shutdown rather than losing it. */
export async function flushPendingPublish(): Promise<void> {
  if (debouncer.isPending()) await debouncer.flushNow();
}

function recentPublishedTitles(limit = 100): string[] {
  // 100 rather than 30: at 5-10 articles a night, 30 titles is only four days
  // of history, far too short a window for the shape-variety rule to work.
  return (
    getDb()
      .prepare(
        "SELECT title FROM articles WHERE status = 'published' ORDER BY published_at DESC LIMIT ?"
      )
      .all(limit) as { title: string }[]
  ).map((r) => r.title);
}

/**
 * Delete an article and its children.
 *
 * Order matters: `foreign_keys = ON` and neither `assets` nor
 * `article_translations` declares ON DELETE CASCADE, so deleting the parent
 * first throws SQLITE_CONSTRAINT_FOREIGNKEY. Every generated article has a
 * thumbnail asset and — now that translation is chained — a translation row,
 * so a parent-first delete fails 100% of the time.
 *
 * Wrapped in a transaction so a partial delete cannot orphan children.
 */
function deleteArticleRow(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM assets WHERE article_id = ?").run(id);
    db.prepare("DELETE FROM article_translations WHERE article_id = ?").run(id);
    db.prepare("DELETE FROM articles WHERE id = ?").run(id);
  })();
}

export function buildGateHandlers(): CallbackHandlers {
  const db = () => getDb();

  return createGateHandlers({
    getKeyword: (id) =>
      db()
        .prepare("SELECT id, query, status, proposed_title FROM keywords WHERE id = ?")
        .get(id) as KeywordRow | undefined,

    approveKeyword: (id) => {
      db()
        .prepare("UPDATE keywords SET status = 'approved', updated_at = datetime('now') WHERE id = ?")
        .run(id);
    },

    rejectKeyword: (id) => {
      db()
        .prepare("UPDATE keywords SET status = 'rejected', updated_at = datetime('now') WHERE id = ?")
        .run(id);
    },

    enqueueGeneration,

    getArticle: (id) =>
      db()
        .prepare("SELECT id, title, slug, status, content FROM articles WHERE id = ?")
        .get(id) as ArticleRow | undefined,

    publishArticle: (id) => {
      const res = db()
        .prepare(
          `UPDATE articles
           SET status = 'published', published_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND status IN ('draft', 'review')`
        )
        .run(id);
      return res.changes > 0;
    },

    deleteArticle: (id) => {
      deleteArticleRow(id);
    },

    regenerateArticle: (id) => {
      const row = db().prepare("SELECT keyword_id FROM articles WHERE id = ?").get(id) as
        | { keyword_id: string }
        | undefined;
      if (!row) return;
      const kw = db()
        .prepare("SELECT id, query, proposed_title FROM keywords WHERE id = ?")
        .get(row.keyword_id) as KeywordRow | undefined;
      if (!kw) return;

      deleteArticleRow(id);
      // Reset the keyword so the pipeline treats it as awaiting generation
      // again, matching what POST /api/articles/:id/regenerate does.
      db().prepare("UPDATE keywords SET status = 'approved' WHERE id = ?").run(kw.id);

      enqueueGeneration({
        keywordId: kw.id,
        query: kw.query,
        titleOverride: kw.proposed_title ?? undefined,
      });
    },

    syncToFramer,
    schedulePublish: () => schedulePublishPersisted(),

    unpublishArticle: (id) => {
      db()
        .prepare(
          "UPDATE articles SET status = 'review', published_at = NULL, updated_at = datetime('now') WHERE id = ?"
        )
        .run(id);
    },

    pendingProposedKeywordIds: () =>
      (
        db()
          .prepare(
            "SELECT id FROM keywords WHERE status = 'pending' AND proposed_title IS NOT NULL"
          )
          .all() as { id: string }[]
      ).map((r) => r.id),

    reviewArticleIds: () =>
      (
        db()
          .prepare("SELECT id FROM articles WHERE status IN ('draft','review') ORDER BY created_at")
          .all() as { id: string }[]
      ).map((r) => r.id),

    recentTitles: () => recentPublishedTitles(),
    proposeTitle,
    saveProposedTitle: (keywordId, title) => {
      db()
        .prepare("UPDATE keywords SET proposed_title = ?, updated_at = datetime('now') WHERE id = ?")
        .run(title, keywordId);
    },

    editMessage,
    alert,
  });
}

/** Send the gate-1 digest and return its Telegram message id. */
async function sendTitleDigest(proposals: TitleProposal[]): Promise<number> {
  const text = buildDigest(
    `${proposals.length} title${proposals.length === 1 ? "" : "s"} proposed`,
    proposals.map((p) => ({ label: p.title, sub: p.query }))
  );

  const rows = proposals.map((p, i) => [
    { text: `✅ ${i + 1}`, data: `gen:${p.keywordId}` },
    { text: `🔄 ${i + 1}`, data: `rrl:${p.keywordId}` },
    { text: `❌ ${i + 1}`, data: `rej:${p.keywordId}` },
  ]);
  rows.push([{ text: "✅ Approve all", data: "genall:" }]);

  const delivered = await sendMessage(text, buildKeyboard(rows));
  if (!delivered) {
    // A run that proposed titles nobody saw has not succeeded. Failing here
    // makes the manual trigger report the problem instead of logging "digest
    // sent" over a Telegram rejection.
    throw new Error(
      "Telegram rejected the gate-1 digest — check the logs for its description (usually a wrong chat_id or malformed HTML)"
    );
  }
  return 0; // sendMessage does not surface the id; digest edits are by content
}

/**
 * Gate 2: tell the operator an article is ready, and give them the buttons to
 * publish, regenerate or delete it.
 *
 * One message per article rather than a batch digest: the article body goes out
 * as an .html attachment (a 1,500-word body is several times Telegram's
 * 4,096-character message limit), and an attachment belongs with the item it
 * describes. The Publish-all button on each message acts on everything in
 * review, so approving a whole batch is still one tap.
 */
export async function sendArticleReadyDigest(articleId: string): Promise<void> {
  const db = getDb();
  const article = db
    .prepare("SELECT id, title, slug, summary, content, status, flags FROM articles WHERE id = ?")
    .get(articleId) as
    | {
        id: string;
        title: string;
        slug: string;
        summary: string | null;
        content: string | null;
        status: string;
        flags: string | null;
      }
    | undefined;

  if (!article) {
    logger.warn({ articleId }, "Article-ready: article not found");
    return;
  }

  if (article.status === "generation_failed") {
    await alert(`Generation failed for "${article.title}" (${article.slug}).`);
    return;
  }

  const ru = db
    .prepare("SELECT title FROM article_translations WHERE article_id = ? AND locale = 'ru'")
    .get(articleId) as { title: string } | undefined;

  const words = (article.content ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

  const flags: string[] = [];
  if (!ru) flags.push("⚠️ RU translation missing");
  try {
    const parsed = JSON.parse(article.flags ?? "{}") as Record<string, unknown>;
    for (const key of Object.keys(parsed)) flags.push(`⚠️ ${key}`);
  } catch {
    /* flags column is best-effort metadata */
  }

  const text = [
    `<b>Ready for review</b>`,
    "",
    `<b>${escapeHtml(article.title)}</b>`,
    ru ? `🇷🇺 ${escapeHtml(ru.title)}` : "",
    "",
    escapeHtml(article.summary ?? ""),
    "",
    `<i>${words} words · /${escapeHtml(article.slug)}</i>`,
    flags.length > 0 ? `\n${flags.join("\n")}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const keyboard = buildKeyboard([
    [
      { text: "🚀 Publish", data: `pub:${article.id}` },
      { text: "🔄 Regenerate", data: `rgn:${article.id}` },
      { text: "🗑 Delete", data: `del:${article.id}` },
    ],
    [{ text: "🚀 Publish all in review", data: "puball:" }],
  ]);

  await sendMessage(text, keyboard);

  // The body as an attachment: Telegram previews .html inline on mobile, and
  // this keeps the operator off a public URL entirely.
  if (article.content) {
    const doc = renderArticleHtml(article.title, article.content, ru?.title ?? null, articleId);
    await sendDocument(`${article.slug}.html`, doc, escapeHtml(article.title));
  }
}

/** Wrap the stored body fragment in a minimal readable document. */
function renderArticleHtml(
  title: string,
  content: string,
  ruTitle: string | null,
  articleId: string
): string {
  const ruContent =
    (
      getDb()
        .prepare("SELECT content FROM article_translations WHERE article_id = ? AND locale = 'ru'")
        .get(articleId) as { content: string | null } | undefined
    )?.content ?? null;

  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 40em; margin: 2em auto; padding: 0 1em; }
  h1 { font-size: 1.6em; line-height: 1.2; }
  hr { margin: 3em 0; border: 0; border-top: 1px solid #ccc; }
  .locale { color: #888; font-size: .8em; text-transform: uppercase; letter-spacing: .08em; }
</style>
<p class="locale">English</p>
<h1>${escapeHtml(title)}</h1>
${content}
${ruContent ? `<hr><p class="locale">Russian</p><h1>${escapeHtml(ruTitle ?? "")}</h1>\n${ruContent}` : ""}`;
}

/** Register the queue hook so finished articles reach gate 2. */
export function registerArticleReadyHandler(): void {
  setArticleReadyHandler(async (articleId) => {
    await sendArticleReadyDigest(articleId);
  });
}

/**
 * The nightly job, callable on demand.
 *
 * Shared by the scheduler and by POST /api/autopilot/run so the manual trigger
 * exercises exactly the code the clock will run — a trigger that took a
 * different path would prove nothing.
 *
 * `dryRun` proposes titles and sends the digest but persists nothing, so a
 * rehearsal leaves no state for the real run to trip over.
 */
export async function runNightlyJob(dryRun: boolean): Promise<void> {
      await runNightly({
        getNiches: () => getSetting<Niche[]>("niches", DEFAULT_NICHES),
        getCursor: () => getSetting("rotationCursor", 0),
        setCursor: (c) => setSetting("rotationCursor", c),

        getPending: () =>
          getDb()
            .prepare("SELECT id, query, source, niche FROM keywords WHERE status = 'pending'")
            .all() as Array<{ id: string; query: string; source: string; niche: string | null }>,
        poolThreshold: getSetting("poolThreshold", 10),
        articlesPerNight: () =>
          randomInt(getSetting("minPerNight", 5), getSetting("maxPerNight", 10)),

        seed: async (req) => {
          await seedTopics(`${req.persona}`, 10, {
            niche: req.niche,
            subniche: req.subniche,
            angle: req.angle,
            kbHints: req.kbHints,
            covered: req.covered,
          });
        },
        getCovered: () => getCoveredTopics(),

        recentTitles: () => recentPublishedTitles(),
        proposeTitle,

        saveProposedTitle: (keywordId, title) => {
          getDb()
            .prepare("UPDATE keywords SET proposed_title = ? WHERE id = ?")
            .run(title, keywordId);
        },
        sendTitleDigest,
        saveDigestMessageId: (id) => setSetting("lastDigestMessageId", id),

        dryRun,
      });
}

/** Guards against a manual trigger colliding with the scheduled run. */
let nightlyInFlight: Promise<void> | null = null;

export async function runNightlyOnce(dryRun: boolean): Promise<{ started: boolean }> {
  if (nightlyInFlight) return { started: false };
  nightlyInFlight = runNightlyJob(dryRun).finally(() => {
    nightlyInFlight = null;
  });
  await nightlyInFlight;
  return { started: true };
}

export function createNightlyRunner(): Runner {
  return createRunner({
    hour: getSetting("scheduleHour", 20),
    getLastRun: () => getSetting<string | null>("lastRunDate", null),
    setLastRun: (date) => setSetting("lastRunDate", date),
    maxAttemptsPerDay: getSetting("maxAttemptsPerDay", 3),
    onExhausted: alert,
    job: () => runNightlyJob(process.env.SCHEDULER_DRY_RUN === "1"),
  });
}

/** Seed default settings on first boot so the plugin has something to edit. */
export function ensureDefaultSettings(): void {
  if (getSetting<Niche[] | null>("niches", null) === null) {
    setSetting("niches", DEFAULT_NICHES);
    logger.info({ count: DEFAULT_NICHES.length }, "Seeded default niche taxonomy");
  }
  if (getSetting<string | null>("framerCollectionId", null) === null && env.FRAMER_COLLECTION_ID) {
    setSetting("framerCollectionId", env.FRAMER_COLLECTION_ID);
  }
}

export { nanoid };
