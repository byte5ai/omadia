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

export interface EmbeddingGateStatusPublication {
  /** The object handed to `ctx.services.provide`. Identity is stable. */
  readonly status: EmbeddingGateStatus;
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
    markStaleVectorClearComplete(): void {
      if (!clearResumeOwed) return;
      // Vector writes stay reported as OFF. The clear really is done and the
      // backfill really is re-embedding, but this process constructed
      // NeonKnowledgeGraph and NeonProcessMemoryStore WITHOUT an embedding
      // client (plugin.ts), so hot-path ingest still stores NULL and
      // processMemory still rejects writes with `embedding-unavailable` until
      // the next restart. Flipping this to true would put back exactly the
      // false-green reading the gate status exists to prevent.
      snapshot = describeGateOutcome(outcome, false, 'completed');
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
        detail: outcome.mismatches
          .map(
            (m) =>
              `${m.table}.${m.column} is vector(${String(m.declaredDimensions ?? 0)})`,
          )
          .join(', '),
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
        'the stale-vector clear finished and the backfill sweep is re-embedding; this process keeps hot-path vector writes disabled until it is restarted',
    };
  }
  return {};
}
