import type { EmbeddingModelGateOutcome } from './embeddingModelGate.js';
import { INITIAL_GATE_EPOCH } from './gateEpoch.js';

/**
 * #440 — the `embeddingModelGateStatus` service, as `/health` consumes it
 * (`EmbeddingGateStatus` in middleware/src/health/kgHealth.ts).
 *
 * Structural contract: the plugin publishes a plain object, the kernel only
 * reads it, and neither side imports the other's types.
 *
 * WHY THIS IS NOT A PLAIN SNAPSHOT. The gate runs exactly once, at plugin
 * activation. Publishing its verdict as a frozen object meant `/health` could
 * no longer lie green (that was the point) but could now lie red indefinitely:
 * a boot that found `clear_pending = TRUE` published
 * `stale-vector-clear-pending`, the backfill sweep finished the clear minutes
 * later, and nothing re-published — so `/health` kept reporting a pending
 * clear until somebody restarted the process. The published object therefore
 * exposes its fields through getters over a snapshot that is REPLACED
 * wholesale when the state changes. The registry keeps one stable reference;
 * readers always see current state; nothing is mutated field by field.
 *
 * #440 follow-up — the same property is what makes a LIVE PROVIDER SWITCH
 * possible. The admin router used to re-activate the whole knowledge-graph
 * plugin to re-run the gate; that calls `graphPool.end()` on the pool the
 * kernel captured once and shares with ~40 subsystems, so a "switch without
 * restart" forced one. The published object now also carries a `reevaluate`
 * entry point (non-enumerable, so it never reaches the health JSON) which
 * re-resolves the embedding client, re-runs the gate and `republish`es the
 * verdict — nothing is torn down.
 */

export interface EmbeddingGateStatus {
  vectorWritesAllowed: boolean;
  status: string;
  reason?: string;
  activeModelId?: string;
  storedModelId?: string;
  detail?: string;
}

/**
 * `reason` value published once the owed clear has drained. Also spelled out
 * in `middleware/src/health/kgHealth.ts`, which words the operator-facing
 * warning for it — keep the two in sync.
 */
export const CLEAR_COMPLETE_REASON = 'stale-vector-clear-complete';
/** `reason` value published while a clear is still owed. */
export const CLEAR_PENDING_REASON = 'stale-vector-clear-pending';
/**
 * `reason` published when the gate rewrote the governed vector columns at the
 * active provider's width. Vector writes ARE allowed in this state — the point
 * of surfacing it is that every stored embedding was destroyed and the
 * backfill sweep is still re-earning them, so recall is degraded even though
 * nothing is broken. Mirrored in `middleware/src/health/kgHealth.ts`.
 */
export const VECTOR_COLUMNS_MIGRATED_REASON = 'vector-columns-migrated';

/**
 * The re-evaluate entry point, as the kernel calls it (#440 follow-up).
 *
 * Attached to the PUBLISHED status object so the admin router reaches it
 * through the `embeddingModelGateStatus` service it already resolves — one
 * service, one lookup, and the same no-shared-types structural contract the
 * rest of this module keeps.
 */
export type GateReevaluate = (
  request?: GateReevaluateRequest,
) => Promise<EmbeddingGateStatus>;

export interface GateReevaluateRequest {
  /**
   * May THIS evaluation rewrite the governed `vector(n)` columns at the new
   * provider's width, destroying every stored embedding?
   *
   * Defaults to false, and is only ever true for an operator who confirmed the
   * discard in the admin UI. Activation never passes it — see the boot-path
   * note in `gateReevaluation.ts`.
   */
  allowDestructiveMigration?: boolean;
}

export interface EmbeddingGateStatusPublication {
  /** The object handed to `ctx.services.provide`. Identity is stable. */
  readonly status: EmbeddingGateStatus;
  /**
   * Are vector writes allowed RIGHT NOW? This is what the plugin's embedding
   * client resolver consults on every ingest, so the answer has to be read
   * live rather than captured — `markStaleVectorClearComplete` and
   * `republish` both change it.
   */
  vectorWritesAllowed(): boolean;
  /**
   * Called by the backfill sweep the moment it drains the owed clear. No-op
   * unless the CURRENT verdict actually owes a clear, so a late or spurious
   * call can never upgrade a `blocked` verdict.
   *
   * #440 follow-up — VERDICT-SCOPED. `callerEpoch` is the gate epoch the
   * caller captured when it started the clear it is reporting on; the call is
   * dropped unless it matches the epoch that armed the CURRENT owed clear.
   * Without that check the `clearResumeOwed` guard alone is not enough: a
   * sweep stood down under verdict A can complete its tick after verdict B
   * republished, and because B also owes a clear the guard passes and writes
   * go ON for a clear that never drained. Harmless while this method kept
   * writes OFF; load-bearing now that it flips them ON.
   */
  markStaleVectorClearComplete(callerEpoch: number): void;
  /**
   * Replace the published verdict wholesale (#440 follow-up).
   *
   * This is what makes a live provider switch possible without tearing the
   * knowledge-graph plugin down. The kernel captured `graphPool` ONCE and ~40
   * subsystems hold that reference, so re-activating the plugin to re-run its
   * gate ended the pool underneath all of them ("Cannot use a pool after
   * calling end on the pool" until the process restarts). Everything the gate
   * publishes is replaceable in place, which makes the teardown unnecessary
   * rather than merely risky.
   *
   * Re-arms `markStaleVectorClearComplete` for whatever the NEW verdict owes:
   * the owed-clear flag is a property of the verdict, not of the boot.
   */
  republish(
    outcome: EmbeddingModelGateOutcome,
    vectorWritesAllowed: boolean,
    clearResumeOwed: boolean,
    /**
     * The gate epoch this verdict was published under (#440 follow-up). It
     * becomes the only epoch `markStaleVectorClearComplete` will accept, so a
     * sweep armed by an earlier verdict cannot report a drain for this one.
     * Omitted keeps the current epoch — for callers with no gate runner.
     */
    epoch?: number,
  ): void;
  /**
   * Attach the re-evaluate entry point to the PUBLISHED object.
   *
   * Non-enumerable on purpose: `/health` and the admin snapshot both
   * JSON-serialise this object, and the entry point must not surface as a
   * field in either. Replaces any previous attachment rather than throwing.
   */
  attachReevaluate(fn: GateReevaluate): void;
}

/** Which of the three clear states the published status describes. */
type ClearState = 'none' | 'pending' | 'completed';

const STATUS_KEYS = [
  'vectorWritesAllowed',
  'status',
  'reason',
  'activeModelId',
  'storedModelId',
  'detail',
] as const;

export function createEmbeddingGateStatus(
  initialOutcome: EmbeddingModelGateOutcome,
  initialVectorWritesAllowed: boolean,
  initialClearResumeOwed: boolean,
  initialEpoch: number = INITIAL_GATE_EPOCH,
): EmbeddingGateStatusPublication {
  // The verdict currently on display. All four move together — a re-evaluation
  // that replaced the outcome but left the owed-clear flag behind would let
  // `markStaleVectorClearComplete` upgrade a verdict that never owed a clear,
  // and one that left the EPOCH behind would let a sweep stood down under the
  // previous verdict report a drain for this one.
  let outcome = initialOutcome;
  let clearResumeOwed = initialClearResumeOwed;
  /** The gate epoch the currently-owed clear was armed under. */
  let clearArmedEpoch = initialEpoch;
  let snapshot = describeGateOutcome(
    outcome,
    initialVectorWritesAllowed,
    clearResumeOwed ? 'pending' : 'none',
  );

  const status = {} as EmbeddingGateStatus;
  for (const key of STATUS_KEYS) {
    Object.defineProperty(status, key, {
      enumerable: true,
      get: () => snapshot[key],
    });
  }

  return {
    status,
    vectorWritesAllowed(): boolean {
      return snapshot.vectorWritesAllowed;
    },
    markStaleVectorClearComplete(callerEpoch: number): void {
      // Guarded on `clearResumeOwed`, which is false for every `blocked`
      // outcome — a late or spurious call can still never upgrade a verdict
      // that never owed a clear. What it CAN do is re-enable writes.
      if (!clearResumeOwed) return;
      // …and guarded on the epoch that armed THIS clear. `clearResumeOwed`
      // alone cannot tell "the sweep I armed finished my clear" from "a sweep
      // I stood down finished someone else's": both arrive with the flag up.
      // `stop()` does not cancel an in-flight tick, so the second case is
      // reachable on every switch that replaces one owed clear with another.
      if (callerEpoch !== clearArmedEpoch) return;
      // Vector writes go back ON, in-process. They used to stay reported as
      // OFF here, and that was correct at the time: the plugin constructed
      // NeonKnowledgeGraph and NeonProcessMemoryStore with a captured
      // `embeddingClient: undefined`, so the stores genuinely could not embed
      // again without a restart and a green reading would have been a lie.
      // Both stores now resolve their client live (see
      // `resolveEmbeddingClient`), and that resolver reads exactly this
      // snapshot — so flipping it true is what actually re-enables the hot
      // path, not a cosmetic upgrade of a stale verdict.
      snapshot = describeGateOutcome(outcome, true, 'completed');
    },
    republish(
      nextOutcome: EmbeddingModelGateOutcome,
      nextVectorWritesAllowed: boolean,
      nextClearResumeOwed: boolean,
      nextEpoch?: number,
    ): void {
      outcome = nextOutcome;
      clearResumeOwed = nextClearResumeOwed;
      if (nextEpoch !== undefined) clearArmedEpoch = nextEpoch;
      snapshot = describeGateOutcome(
        nextOutcome,
        nextVectorWritesAllowed,
        nextClearResumeOwed ? 'pending' : 'none',
      );
    },
    attachReevaluate(fn: GateReevaluate): void {
      Object.defineProperty(status, 'reevaluate', {
        enumerable: false,
        configurable: true,
        writable: true,
        value: fn,
      });
    },
  };
}

/** Flatten a gate outcome plus the current clear state into the health shape. */
export function describeGateOutcome(
  outcome: EmbeddingModelGateOutcome,
  vectorWritesAllowed: boolean,
  clearState: ClearState,
): EmbeddingGateStatus {
  const base = { vectorWritesAllowed, status: outcome.status };
  if (outcome.status === 'blocked') {
    if (outcome.reason === 'column-width-mismatch') {
      return {
        ...base,
        reason: outcome.reason,
        activeModelId: `${outcome.modelId} (${String(outcome.dimensions)}d)`,
        detail: [
          outcome.mismatches
            .map(
              (m) =>
                `${m.table}.${m.column} is vector(${String(m.declaredDimensions ?? 0)})`,
            )
            .join(', '),
          // An auto-migration that moved columns and could not record it makes
          // the width complaint above an incomplete description of the schema.
          // Naming the split here is what keeps it out of "silently stuck".
          ...(outcome.migrationHazard !== undefined
            ? [`SCHEMA/REGISTRY SPLIT: ${outcome.migrationHazard}`]
            : []),
        ].join(' — '),
      };
    }
    return {
      ...base,
      reason: outcome.reason,
      activeModelId: `${outcome.modelId} (${String(outcome.dimensions)}d)`,
      storedModelId: `${outcome.storedModelId} (${String(outcome.storedDimensions)}d)`,
      ...(outcome.reason === 'registry-conflict' ? { detail: outcome.detail } : {}),
    };
  }
  // `unknown-provider` has no model to name — but it CAN carry an owed clear
  // now, so it goes through the same clear-note path as the rest.
  if (outcome.status === 'unknown-provider') {
    return { ...base, ...describeClearState(clearState) };
  }
  // A runtime column migration is NOT a degradation of the write path — it
  // re-enabled it — but it destroyed the corpus on the way, so it has to be
  // visible rather than quietly successful.
  if (outcome.status === 'column-migrated') {
    const columns = outcome.migratedColumns
      .map(
        (m) =>
          `${m.table}.${m.column} vector(${String(m.previousDimensions ?? 0)})→vector(${String(m.newDimensions)})`,
      )
      .join(', ');
    const discarded =
      outcome.discardedVectors === undefined
        ? 'an unknown number of'
        : String(outcome.discardedVectors);
    const migrated = `${columns} were rewritten at runtime; ${discarded} stored vector(s) were discarded`;
    // `clearState` rather than `outcome.clearPending`: the outcome is frozen at
    // activation, the clear state is not. A migration whose capped
    // retry-counter reset was still owed must go green the moment the backfill
    // sweep drains it — the same no-restart transition every other pending
    // clear gets, and the whole reason this module is not a plain snapshot.
    const note =
      clearState === 'none'
        ? { reason: VECTOR_COLUMNS_MIGRATED_REASON }
        : clearState === 'pending'
          ? {
              reason: CLEAR_PENDING_REASON,
              suffix:
                '. The capped retry-counter reset is still owed, so vector writes stay refused until a resumer drains it',
            }
          : {
              reason: CLEAR_COMPLETE_REASON,
              suffix:
                '. The owed retry-counter reset finished and hot-path vector writes were re-enabled without a restart',
            };
    return {
      ...base,
      reason: note.reason,
      activeModelId: `${outcome.modelId} (${String(outcome.dimensions)}d)`,
      ...(outcome.previousModelId !== undefined
        ? {
            storedModelId: `${outcome.previousModelId} (${String(outcome.previousDimensions ?? 0)}d)`,
          }
        : {}),
      detail:
        clearState === 'none'
          ? `${migrated} and the backfill sweep is re-embedding them`
          : `${migrated}${'suffix' in note ? note.suffix : ''}`,
    };
  }
  return {
    ...base,
    activeModelId: outcome.modelId,
    ...(outcome.status === 're-embedding'
      ? { storedModelId: outcome.previousModelId }
      : {}),
    ...describeClearState(clearState),
  };
}

function describeClearState(
  clearState: ClearState,
): { reason?: string; detail?: string } {
  if (clearState === 'pending') {
    return {
      reason: CLEAR_PENDING_REASON,
      detail:
        'a same-width embedding-model switch is still dropping old vectors; writes resume when the backfill sweep finishes',
    };
  }
  if (clearState === 'completed') {
    return {
      reason: CLEAR_COMPLETE_REASON,
      detail:
        'the stale-vector clear finished; hot-path vector writes were re-enabled in this process without a restart, and the backfill sweep is re-embedding the corpus',
    };
  }
  return {};
}
