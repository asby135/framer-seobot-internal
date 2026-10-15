import { nextSlot, probationaryNames, countPairs, type Niche } from "./taxonomy.js";
import { selectTopics, needsTopUp, unofferedInNiche, type PendingTopic } from "./selection.js";
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
  /** How many titles to ask this slot for. */
  count: number;
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

  /**
   * Persist the headline shown at gate 1.
   *
   * Two things depend on it, and both broke silently when the topic-to-title
   * conversion was removed and proposed_title stopped being written: Approve
   * All finds tonight's topics by it, and approving pins it as the generated
   * article's title.
   */
  recordProposals(proposals: TitleProposal[]): void;

  sendTitleDigest(proposals: TitleProposal[]): Promise<number>;

  /**
   * Tell the operator something they need to act on — here, a night with
   * nothing to propose. Optional so a rehearsal or a test can omit it.
   */
  notify?(message: string): Promise<void>;
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
/**
 * How many titles one rotation slot is asked for.
 *
 * Small on purpose. A slot is one (niche, subniche, article type), so its
 * titles are siblings — ten of them is ten takes on one corner of one audience,
 * and the pool a night draws from is mostly the latest seeds. At ten per slot a
 * digest read as two or three subjects ("move fans to Telegram" three times in
 * one night) even while the blog as a whole was balanced. Four per slot fills
 * the same pool from more than twice as many places.
 *
 * The cost is a shorter rotation runway per slot visit, which is fine: the
 * slot comes round again, and the covered list plus the near-duplicate guard
 * in insertSeededTopics keep the second visit off the first one's ground.
 */
export const SEED_BATCH_SIZE = 4;

/**
 * How many rotation slots one run may seed. Bounded so a seeder returning
 * nothing (every candidate a duplicate) cannot spin; sized so that one run can
 * still refill the largest night the settings allow (20 articles).
 */
export const MAX_SEEDS_PER_RUN = 6;

/**
 * How many unoffered topics a probationary niche may hold before its rotation
 * slots stop seeding.
 *
 * Probationary topics are seeded so the operator can judge the niche, but
 * selection never picks them, so beyond a sample to review they are dead
 * weight. Without a cap, a night where every niche is on probation would seed
 * on every run forever — which is why top-up used to count probationary topics
 * as runway, and THAT stalled the digest. Capping the sample lets top-up count
 * only what selection can use.
 */
export const PROBATION_SAMPLE_SIZE = 2 * SEED_BATCH_SIZE;

export async function runNightly(deps: AutopilotDeps): Promise<TitleProposal[]> {
  // 1. Top up. Measured against USABLE topics only: a pool full of excluded
  //    rows is not runway, however large it looks.
  const niches = deps.getNiches();
  // Probationary niches are seeded but never auto-selected: their topics land
  // as `pending` for the operator to judge. Excluding them from seeding instead
  // meant they produced nothing and the operator waited for topics that could
  // never arrive.
  const onProbation = probationaryNames(niches);

  // Top-up counts only what selection can propose, so probationary topics are
  // NOT runway (see needsTopUp). What stops a probationary niche piling up
  // topics forever is the per-niche sample cap below.
  //
  // Seed until the pool clears the threshold rather than exactly once. One seed
  // per run could never fill a pool whose threshold was at or above the batch
  // size: the queue settled on the boundary and stopped topping up for good,
  // freezing both the pool AND the cursor, so every night re-drew the same ten
  // topics from one slot. Bounded at MAX_SEEDS_PER_RUN so a seeder returning
  // nothing (every candidate a duplicate) cannot spin.
  let seeds = 0;
  // A full lap of probationary slots that all already have their sample means
  // there is nothing left to seed; stop rather than walk the rotation forever.
  let skipped = 0;
  const lap = countPairs(niches);
  // A failed seed must not cost the night: the pool usually already holds
  // enough to propose. Remembered so a night with nothing to propose can
  // still fail loudly and be retried.
  let seedError: unknown = null;
  let noRotatableNiche = false;

  while (seeds < MAX_SEEDS_PER_RUN && needsTopUp(deps.getPending(), deps.poolThreshold, onProbation)) {
    const slot = nextSlot(niches, deps.getCursor());
    if (!slot) {
      // No niche has subniches, or none configured. Not an error: the run
      // proceeds on whatever is already pending.
      logger.warn("No rotatable niche available — skipping top-up");
      noRotatableNiche = true;
      break;
    }

    if (
      slot.niche.probation &&
      unofferedInNiche(deps.getPending(), slot.niche.name) >= PROBATION_SAMPLE_SIZE
    ) {
      // Its sample is waiting for review; more would only pile up topics that
      // selection can never pick. Move on to the next slot.
      deps.setCursor(slot.cursor);
      if (++skipped >= lap) break;
      continue;
    }

    logger.info(
      { niche: slot.niche.name, subniche: slot.subniche, angle: slot.angle, seed: seeds + 1 },
      "Topic pool low — seeding from rotation slot"
    );
    try {
      // Re-read covered inside the loop so a second seed does not repeat what
      // the first just wrote.
      await deps.seed({
        niche: slot.niche.name,
        persona: slot.niche.persona,
        subniche: slot.subniche,
        angle: slot.angle,
        kbHints: slot.niche.kb_hints,
        covered: deps.getCovered(),
        count: SEED_BATCH_SIZE,
      });
    } catch (e) {
      // The cursor stays put, so the next run retries this slot.
      seedError = e;
      logger.error(
        { niche: slot.niche.name, error: e instanceof Error ? e.message : "unknown" },
        "Seeding failed — proposing from the existing pool instead"
      );
      break;
    }
    deps.setCursor(slot.cursor);
    seeds++;
  }

  // 2. Select. Re-read the pool so freshly seeded topics are eligible tonight.
  const count = deps.articlesPerNight();
  const selected = selectTopics(deps.getPending(), count, Math.random, onProbation);
  if (selected.length === 0) {
    // Nothing to propose because seeding broke: fail, so the scheduler retries
    // and, if it keeps failing, alerts.
    if (seedError) throw seedError;

    logger.warn("No usable topics available — nothing to propose tonight");
    // A silent night is indistinguishable from a broken bot. Say why.
    if (!deps.dryRun) {
      await deps.notify?.(nothingToProposeMessage(deps.getPending(), onProbation, noRotatableNiche));
    }
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

  // Record before sending: the digest's buttons act on these rows, so a
  // digest the operator can see but not act on is worse than no digest.
  deps.recordProposals(proposals);

  const messageId = await deps.sendTitleDigest(proposals);
  deps.saveDigestMessageId(messageId);

  logger.info({ proposed: proposals.length }, "Gate 1 digest sent");
  return proposals;
}

/** Why a night proposed nothing, in terms the operator can act on. */
function nothingToProposeMessage(
  pending: PendingTopic[],
  onProbation: Set<string>,
  noRotatableNiche: boolean
): string {
  const held = new Map<string, number>();
  for (const t of pending) {
    if (t.niche && onProbation.has(t.niche)) held.set(t.niche, (held.get(t.niche) ?? 0) + 1);
  }
  const base = "No titles tonight — there are no new topics to propose.";
  if (noRotatableNiche) return `${base} No niche has any subniches to seed from — add some in the plugin's Settings.`;
  if (held.size === 0) return `${base} Seeding produced nothing usable; check the logs.`;
  const list = [...held].map(([n, c]) => `${n} (${c})`).join(", ");
  return `${base} Topics waiting in probationary niches: ${list}. Approve some in the plugin, or clear probation in Settings once a niche's output looks right.`;
}
