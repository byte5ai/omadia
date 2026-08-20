/**
 * #757 — persistent per-turn audit receipts.
 *
 * The `PrivacyReceipt` (see `privacyReceipt.ts`) is emitted once per turn and
 * was, until #757, attached to the `done` event and then gone — an operator
 * could never answer "what did the system disclose or mask for turn X last
 * Tuesday?". This service persists that receipt, guaranteed per turn, into a
 * kernel-owned store (`turn_receipts`, migration `0039`).
 *
 * Deliberately NOT the RunTrace: the trace is best-effort telemetry behind an
 * optional graph sink (`runTraceObservability.ts` documents why it must not be
 * promised as a record). This store has no user-cluster precondition and no
 * optional sink — a turn either lands here or the failure is counted and
 * logged loudly.
 *
 * The record stays PII-free by construction: it carries the receipt's counts
 * plus routing metadata (turn id, session scope, channel kind, model). The
 * `turnId`+`scope` pair is personal-data *linkage*, so retention is bounded
 * (`RECEIPT_RETENTION_DAYS`) and enforced by a reaper.
 */

import type { PrivacyReceipt } from './privacyReceipt.js';

/**
 * Service-registry name the kernel publishes its store under. The
 * harness-orchestrator resolves it late-bound (per turn, like
 * `privacyRedact`) so boot order does not matter; absent service — e.g. the
 * in-memory backend, unit tests — means receipts stay ephemeral, exactly the
 * pre-#757 behaviour.
 */
export const TURN_RECEIPT_STORE_SERVICE_NAME = 'turnReceiptStore';

/** One persisted per-turn receipt row. PII-free: counts + routing metadata. */
export interface TurnReceiptRecordInput {
  /** The orchestrator's per-turn id — unique key of the row. */
  readonly turnId: string;
  /** Session-transcript bucket the turn ran in (`ChatTurnInput.sessionScope`). */
  readonly sessionScope?: string;
  /** Channel kind when the dispatcher mapped one (`channelIdentity.channelKind`). */
  readonly channel?: string;
  /** Model id the orchestrator was configured with for this turn. */
  readonly model?: string;
  /** The turn's aggregated privacy receipt, verbatim. */
  readonly receipt: PrivacyReceipt;
}

export interface TurnReceiptStore {
  /**
   * Persist one turn's receipt. Idempotent on `turnId` (a replayed `done`
   * event must not duplicate the row). Implementations throw on storage
   * failure — the caller decides whether the turn survives (it does; the
   * failure is counted and logged, never swallowed silently).
   */
  record(entry: TurnReceiptRecordInput): Promise<void>;
}
