// Retention for stored conversation messages (#2043). The kernel keeps what a
// subscription received only as long as it is useful as the authoritative
// record: while subscribed, plus a short grace period so an engine can finish
// its own protocol, and never longer than a maximum age. The engine plugin
// keeps what it needs in its own tables.

import type { ConversationMessageHub } from './hub.js';
import type { ConversationMessageStore } from './store.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ConversationMessagePurgeOptions {
  /** How long events outlive the end of their subscription. */
  readonly graceMs: number;
  /** Maximum age of any stored event in days; 0 disables the age limit. */
  readonly maxAgeDays: number;
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface ConversationMessagePurgeJob {
  tick(): Promise<void>;
  stop(): void;
}

export function startConversationMessagePurge(
  store: ConversationMessageStore,
  hub: ConversationMessageHub | undefined,
  options: ConversationMessagePurgeOptions,
): ConversationMessagePurgeJob {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const at = now();
      const result = await store.purge({
        endedBefore: new Date(at - options.graceMs),
        ...(options.maxAgeDays > 0
          ? { receivedBefore: new Date(at - options.maxAgeDays * MS_PER_DAY) }
          : {}),
      });
      if (result.events > 0 || result.subscriptions > 0) {
        log(
          `[conversation-messages] purged ${String(result.events)} event(s) of ${String(result.subscriptions)} ended subscription(s)`,
        );
      }
      // Pick up subscriptions another machine wrote or ended.
      await hub?.refresh();
    } catch (err) {
      log(`[conversation-messages] purge failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
