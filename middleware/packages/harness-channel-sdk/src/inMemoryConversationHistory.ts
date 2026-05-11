/**
 * In-memory implementation of the channel-agnostic ConversationHistoryStore.
 *
 * Phase 5B: lifted from `middleware/src/services/conversationHistory.ts`
 * so dynamic-imported channel plugins can construct their own per-channel
 * instance without depending on a kernel singleton. Two safety caps keep
 * memory bounded:
 *   - maxTurnsPerScope: tail only, oldest turns dropped.
 *   - scopeTtlMs: an idle scope is pruned whole on the next access.
 *
 * Channels that consume the topic-detector also use the four `pending`
 * methods (markPending / getPending / clearPending / resetTurns). Channels
 * that don't (Telegram today) can ignore them — they are no-ops on
 * unknown scopes.
 *
 * Not concurrency-safe across processes; single-instance per channel.
 * Two concurrent turns in the same scope would race the append; the
 * orchestrator serialises turns per chat so that race never arises in
 * practice.
 */

/** A single round-trip: user message + assistant answer. */
export interface ConversationTurn {
  userMessage: string;
  assistantAnswer: string;
  /** Unix millis of the user message. */
  at: number;
}

/**
 * Record of a user message that triggered the topic-detector's "ask" branch.
 * While `pending` is set on a scope, the bot is waiting for the user to pick
 * "continue" or "reset" via the channel-native button payload; a fresh user
 * message in between resolves it implicitly.
 */
export interface PendingTopicDecision {
  /** The user's original message that triggered the clarification. */
  userMessage: string;
  /** Unix millis of when we asked. */
  askedAt: number;
}

export interface InMemoryConversationHistoryStoreOptions {
  /** Max turns kept per scope. Oldest dropped first. Defaults to 10. */
  maxTurnsPerScope?: number;
  /** Idle expiry per scope. Defaults to 2 hours. */
  scopeTtlMs?: number;
  /** Cap on number of distinct scopes. Oldest evicted if exceeded. */
  maxScopes?: number;
}

interface ScopeBucket {
  turns: ConversationTurn[];
  lastAccessMs: number;
  accessSeq: number;
  pending?: PendingTopicDecision;
}

export class InMemoryConversationHistoryStore {
  private readonly maxTurns: number;
  private readonly ttlMs: number;
  private readonly maxScopes: number;
  private readonly buckets = new Map<string, ScopeBucket>();
  private accessSeq = 0;

  constructor(opts: InMemoryConversationHistoryStoreOptions = {}) {
    this.maxTurns = opts.maxTurnsPerScope ?? 10;
    this.ttlMs = opts.scopeTtlMs ?? 2 * 60 * 60 * 1000;
    this.maxScopes = opts.maxScopes ?? 500;
  }

  get(scope: string): ConversationTurn[] {
    const bucket = this.buckets.get(scope);
    if (!bucket) return [];
    const now = Date.now();
    if (now - bucket.lastAccessMs > this.ttlMs) {
      this.buckets.delete(scope);
      return [];
    }
    bucket.lastAccessMs = now;
    bucket.accessSeq = ++this.accessSeq;
    return bucket.turns.slice();
  }

  append(scope: string, turn: ConversationTurn): void {
    if (!scope) return;
    if (turn.userMessage.length === 0 && turn.assistantAnswer.length === 0) {
      return;
    }
    const now = Date.now();
    let bucket = this.buckets.get(scope);
    if (!bucket) {
      if (this.buckets.size >= this.maxScopes) {
        let oldestScope: string | undefined;
        let oldestSeq = Infinity;
        for (const [k, v] of this.buckets.entries()) {
          if (v.accessSeq < oldestSeq) {
            oldestSeq = v.accessSeq;
            oldestScope = k;
          }
        }
        if (oldestScope !== undefined) this.buckets.delete(oldestScope);
      }
      bucket = { turns: [], lastAccessMs: now, accessSeq: ++this.accessSeq };
      this.buckets.set(scope, bucket);
    }
    bucket.turns.push(turn);
    if (bucket.turns.length > this.maxTurns) {
      bucket.turns.splice(0, bucket.turns.length - this.maxTurns);
    }
    bucket.lastAccessMs = now;
    bucket.accessSeq = ++this.accessSeq;
  }

  resetTurns(scope: string): void {
    const bucket = this.buckets.get(scope);
    if (!bucket) return;
    bucket.turns = [];
    bucket.pending = undefined;
    bucket.lastAccessMs = Date.now();
    bucket.accessSeq = ++this.accessSeq;
  }

  markPending(scope: string, pending: PendingTopicDecision): void {
    const now = Date.now();
    let bucket = this.buckets.get(scope);
    if (!bucket) {
      bucket = { turns: [], lastAccessMs: now, accessSeq: ++this.accessSeq };
      this.buckets.set(scope, bucket);
    }
    bucket.pending = pending;
    bucket.lastAccessMs = now;
    bucket.accessSeq = ++this.accessSeq;
  }

  getPending(scope: string): PendingTopicDecision | undefined {
    return this.buckets.get(scope)?.pending;
  }

  clearPending(scope: string): void {
    const bucket = this.buckets.get(scope);
    if (!bucket) return;
    bucket.pending = undefined;
    bucket.lastAccessMs = Date.now();
    bucket.accessSeq = ++this.accessSeq;
  }

  size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}
