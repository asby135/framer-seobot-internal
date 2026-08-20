import { nextSlot, probationaryNames, type Niche } from "./taxonomy.js";
import { selectTopics, needsTopUp, type PendingTopic } from "./selection.js";
import { logger } from "../lib/logger.js";

/**
 * The nightly pipeline, gate 1.
 *
 * Every dependency is injected so the ordering guarantees — top up before
 * selecting, propose before sending, persist only outside dry-run — are
 * testable without a database, Anthropic or Telegram.
 */

export interface SeedRequest {
  niche: string;
  persona: string;
  subniche: string;
  angle: string;
  kbHints: string[];
  covered: string[];
}

export interface TitleProposal {
  keywordId: string;
  query: string;
  title: string;
}

export interface AutopilotDeps {
  getNiches(): Niche[];
  getCursor(): number;
  setCursor(cursor: number): void;

  getPending(): PendingTopic[];
  poolThreshold: number;
  /** Randomised per night, e.g. 5-10. */
  articlesPerNight(): number;

  seed(req: SeedRequest): Promise<void>;
  getCovered(): string[];

  recentTitles(): string[];
  proposeTitle(topic: string, recentTitles: string[], rejected: string[]): Promise<string>;

  saveProposedTitle(keywordId: string, title: string): void;
  sendTitleDigest(proposals: TitleProposal[]): Promise<number>;
  saveDigestMessageId(messageId: number): void;

  /** Propose and notify, but persist nothing and generate nothing. */
  dryRun: boolean;
}

/**
 * Run the evening half of the pipeline: top up the topic pool if needed,
 * select tonight's topics, propose a headline for each, and send the gate-1
 * digest.
 *
 * Generation deliberately does NOT happen here — it is triggered by the
 * operator approving a title, so nothing is spent on an article they have not
 * agreed to.
 */
export async function runNightly(deps: AutopilotDeps): Promise<void> {
  // 1. Top up. Measured against USABLE topics only: a pool full of excluded
  //    rows is not runway, however large it looks.
  const niches = deps.getNiches();
  // Probationary niches are seeded but never auto-selected: their topics land
  // as `pending` for the operator to judge. Excluding them from seeding instead
  // meant they produced nothing and the operator waited for topics that could
  // never arrive.
  const onProbation = probationaryNames(niches);

  const pending = deps.getPending();
  if (needsTopUp(pending, deps.poolThreshold, onProbation)) {
    const slot = nextSlot(niches, deps.getCursor());
    if (slot) {
      logger.info(
        { niche: slot.niche.name, subniche: slot.subniche, angle: slot.angle },
        "Topic pool low — seeding from rotation slot"
      );
      await deps.seed({
        niche: slot.niche.name,
        persona: slot.niche.persona,
        subniche: slot.subniche,
        angle: slot.angle,
        kbHints: slot.niche.kb_hints,
        covered: deps.getCovered(),
      });
      deps.setCursor(slot.cursor);
    } else {
      // Every niche on probation, or none configured. Not an error: the run
      // proceeds on whatever is already pending.
      logger.warn("No rotatable niche available — skipping top-up");
    }
  }

  // 2. Select. Re-read the pool so freshly seeded topics are eligible tonight.
  const count = deps.articlesPerNight();
  const selected = selectTopics(deps.getPending(), count, Math.random, onProbation);
  if (selected.length === 0) {
    logger.warn("No usable topics available — nothing to propose tonight");
    return;
  }

  // 3. Propose a headline per topic.
  //
  // Each proposal sees the ones already chosen TONIGHT, not just recently
  // published titles. Without this, proposals are generated independently and
  // collide with each other: a live digest produced three headlines out of four
  // opening with a quantity, which is precisely the formulaic tell the shape
  // rules exist to prevent.
  const published = deps.recentTitles();
  const chosenTonight: string[] = [];
  const proposals: TitleProposal[] = [];

  for (const topic of selected) {
    const title = await deps.proposeTitle(topic.query, [...published, ...chosenTonight], []);
    chosenTonight.push(title);
    proposals.push({ keywordId: topic.id, query: topic.query, title });
  }

  // 4. Persist, then notify. Dry-run stops short of persisting so a rehearsal
  //    leaves no state behind for the real run to trip over.
  if (!deps.dryRun) {
    for (const p of proposals) deps.saveProposedTitle(p.keywordId, p.title);
  }

  const messageId = await deps.sendTitleDigest(proposals);
  if (!deps.dryRun) deps.saveDigestMessageId(messageId);

  logger.info(
    { proposed: proposals.length, dryRun: deps.dryRun },
    "Gate 1 digest sent"
  );
}
