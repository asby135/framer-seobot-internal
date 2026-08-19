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
import { buildDigest, buildKeyboard, sendMessage, editMessage, alert } from "./notify.js";
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
  publish: publishFramerSite,
  onError: alert,
});

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
      db().prepare("DELETE FROM articles WHERE id = ?").run(id);
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
      db().prepare("DELETE FROM articles WHERE id = ?").run(id);
      enqueueGeneration({
        keywordId: kw.id,
        query: kw.query,
        titleOverride: kw.proposed_title ?? undefined,
      });
    },

    syncToFramer,
    schedulePublish: () => debouncer.schedule(),

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

  await sendMessage(text, buildKeyboard(rows));
  return 0; // sendMessage does not surface the id; digest edits are by content
}

export function createNightlyRunner(): Runner {
  return createRunner({
    hour: getSetting("scheduleHour", 20),
    getLastRun: () => getSetting<string | null>("lastRunDate", null),
    setLastRun: (date) => setSetting("lastRunDate", date),
    job: async () => {
      await runNightly({
        getNiches: () => getSetting<Niche[]>("niches", DEFAULT_NICHES),
        getCursor: () => getSetting("rotationCursor", 0),
        setCursor: (c) => setSetting("rotationCursor", c),

        getPending: () =>
          getDb()
            .prepare("SELECT id, query, source FROM keywords WHERE status = 'pending'")
            .all() as Array<{ id: string; query: string; source: string }>,
        poolThreshold: getSetting("poolThreshold", 10),
        articlesPerNight: () =>
          randomInt(getSetting("minPerNight", 5), getSetting("maxPerNight", 10)),

        seed: async (req) => {
          await seedTopics(`${req.persona}`, 10, {
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

        dryRun: process.env.SCHEDULER_DRY_RUN === "1",
      });
    },
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
