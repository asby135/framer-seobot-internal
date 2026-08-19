import { logger } from "../lib/logger.js";

/**
 * Debounce the Framer site publish.
 *
 * Publishing rebuilds and redeploys the whole site, and Framer has signalled
 * usage-based pricing after the beta. Approving ten articles in a review
 * session must therefore produce ONE deploy, not ten — so every approval
 * restarts a short countdown and only the last one fires.
 */

const RETRY_DELAY_MS = 30_000;

export interface DebouncerConfig {
  delayMs: number;
  publish: () => Promise<void>;
  /** Called only after the retry also fails. */
  onError: (message: string) => Promise<void>;
}

export interface PublishDebouncer {
  /** Arm or re-arm the countdown. */
  schedule(): void;
  /** Publish now, cancelling any pending timer. */
  flushNow(): Promise<void>;
  /** Discard a pending publish without running it. */
  cancel(): void;
  isPending(): boolean;
}

export function createPublishDebouncer(config: DebouncerConfig): PublishDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const runWithRetry = async (): Promise<void> => {
    try {
      await config.publish();
      return;
    } catch (e) {
      const first = e instanceof Error ? e.message : "unknown";
      logger.warn({ error: first }, "Framer publish failed — retrying once");

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      try {
        await config.publish();
        logger.info("Framer publish succeeded on retry");
        return;
      } catch (e2) {
        const second = e2 instanceof Error ? e2.message : "unknown";
        logger.error({ first, second }, "Framer publish failed twice — giving up");
        await config.onError(`Framer publish failed twice: ${second}`);
      }
    }
  };

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        void runWithRetry();
      }, config.delayMs);
    },

    async flushNow() {
      if (timer === null) return;
      clear();
      await runWithRetry();
    },

    cancel() {
      clear();
    },

    isPending() {
      return timer !== null;
    },
  };
}
