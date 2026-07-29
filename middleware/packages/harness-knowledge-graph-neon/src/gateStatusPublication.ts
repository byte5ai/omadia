import type { EmbeddingModelGateOutcome } from './embeddingModelGate.js';

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

export interface EmbeddingGateStatusPublication {
  /** The object handed to `ctx.services.provide`. Identity is stable. */
  readonly status: EmbeddingGateStatus;
  /**
   * Are vector writes allowed RIGHT NOW? This is what the plugin's embedding
   * client resolver consults on every ingest, so the answer has to be read
   * live rather than captured — `markStaleVectorClearComplete` changes it.
   */
  vectorWritesAllowed(): boolean;
  /**
   * Called by the backfill sweep the moment it drains the owed clear. No-op
   * unless this boot actually published a pending clear, so a late or spurious
   * call can never upgrade a `blocked` verdict.
   */
  markStaleVectorClearComplete(): void;
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
  outcome: EmbeddingModelGateOutcome,
  vectorWritesAllowed: boolean,
  clearResumeOwed: boolean,
): EmbeddingGateStatusPublication {
  let snapshot = describeGateOutcome(
    outcome,
    vectorWritesAllowed,
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
    markStaleVectorClearComplete(): void {
      // Guarded on `clearResumeOwed`, which is false for every `blocked`
      // outcome — a late or spurious call can still never upgrade a verdict
      // this boot never made. What it CAN do now is re-enable writes.
      if (!clearResumeOwed) return;
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
