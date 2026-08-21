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

  sendTitleDigest(proposals: TitleProposal[]): Promise<number>;
  saveDigestMessageId(messageId: number): void;

  /**
   * Seed and select as normal, but return the titles instead of sending the
   * digest. Lets the pipeline be exercised without messaging the group.
   */
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
export async function runNightly(deps: AutopilotDeps): Promise<TitleProposal[]> {
  // 1. Top up. Measured against USABLE topics only: a pool full of excluded
  //    rows is not runway, however large it looks.
  const niches = deps.getNiches();
  // Probationary niches are seeded but never auto-selected: their topics land
  // as `pending` for the operator to judge. Excluding them from seeding instead
  // meant they produced nothing and the operator waited for topics that could
  // never arrive.
  const onProbation = probationaryNames(niches);

  const pending = deps.getPending();
  // Top-up counts probationary topics: they are real topics sitting in the
  // queue awaiting review, so they DO fill the pool. Excluding them here meant
  // that with every niche on probation the pool never looked full — seeding
  // fired every night, forever, while selection returned nothing.
  if (needsTopUp(pending, deps.poolThreshold)) {
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
    return [];
  }

  // 3. The seeded phrase IS the title.
  //
  // There used to be a second Claude call here rewriting each topic into a
  // headline. That existed because Era supplied raw search queries that needed
  // turning into prose. With Era retired and the seeder writing finished,
  // task-shaped titles itself, the conversion was a wasted call and a place for
  // the two prompts to drift apart — which they did, until titles stopped
  // containing their own keyword.
  const proposals: TitleProposal[] = selected.map((topic) => ({
    keywordId: topic.id,
    query: topic.query,
    title: topic.query,
  }));

  // 4. Notify — unless this is a rehearsal, in which case hand the titles back
  //    to the caller instead of pinging the group.
  if (deps.dryRun) {
    logger.info({ proposed: proposals.length }, "Dry run — digest not sent");
    return proposals;
  }

  const messageId = await deps.sendTitleDigest(proposals);
  deps.saveDigestMessageId(messageId);

  logger.info({ proposed: proposals.length }, "Gate 1 digest sent");
  return proposals;
}
