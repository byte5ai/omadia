/**
 * In-memory pending-flow store (HANDOFF §5.1).
 *
 * Holds the server-side half of an in-flight OAuth roundtrip:
 *   - codeVerifier (the secret half of PKCE — never leaves the server)
 *   - jobId + fieldKey (where the resulting tokens go)
 *   - scopes (so refresh requests can repeat them)
 *
 * Single-process by design. If the middleware ever scales to ≥2 instances
 * on Fly, this becomes a SQLite/Redis table — the API stays the same.
 *
 * Entries auto-expire after 10 minutes (the same TTL the signed state
 * carries) so the store can't grow unbounded if callbacks never come back.
 */

import crypto from 'node:crypto';

export interface PendingFlow {
  flowId: string;
  jobId: string;
  fieldKey: string;
  providerId: string;
  codeVerifier: string;
  scopes: string[];
  /** Epoch ms — used by the test-doubles to assert TTL behaviour. */
  createdAt: number;
}

export interface PendingFlowInit {
  jobId: string;
  fieldKey: string;
  providerId: string;
  codeVerifier: string;
  scopes: string[];
}

export interface PendingFlowStoreOptions {
  /** Override the TTL — defaults to 10 minutes. The signed state JWT
   *  carries the same window, so an expired-flow lookup and an
   *  expired-state JWT-verify will fail at roughly the same time. */
  ttlMs?: number;
  /** Override the now-source for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class PendingFlowStore {
  private readonly entries = new Map<string, PendingFlow>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: PendingFlowStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Create a new flow with a fresh server-generated id and arm its
   *  expiry-timer. Returns the stored flow including its id so the
   *  caller can put it into the signed state. */
  create(init: PendingFlowInit): PendingFlow {
    const flowId = crypto.randomUUID();
    const flow: PendingFlow = {
      flowId,
      jobId: init.jobId,
      fieldKey: init.fieldKey,
      providerId: init.providerId,
      codeVerifier: init.codeVerifier,
      scopes: [...init.scopes],
      createdAt: this.now(),
    };
    this.entries.set(flowId, flow);
    const timer = setTimeout(() => {
      this.entries.delete(flowId);
      this.timers.delete(flowId);
    }, this.ttlMs);
    // Don't keep the process alive just because an OAuth flow is pending.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(flowId, timer);
    return flow;
  }

  /** Read a pending flow. Does NOT delete — the callback handler decides
   *  when to consume (after successful exchange). */
  get(flowId: string): PendingFlow | undefined {
    return this.entries.get(flowId);
  }

  /** Consume and delete in one step (the success-path of /callback). */
  take(flowId: string): PendingFlow | undefined {
    const flow = this.entries.get(flowId);
    if (!flow) return undefined;
    this.entries.delete(flowId);
    const timer = this.timers.get(flowId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(flowId);
    }
    return flow;
  }

  /** For diagnostics + tests. */
  size(): number {
    return this.entries.size;
  }

  /** Cancel all timers + drop all entries. Call from process-shutdown
   *  hooks so `node --test` stops cleanly. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.entries.clear();
  }
}
