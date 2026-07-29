import type { EmbeddingClient } from '@omadia/plugin-api';
import { readEmbeddingProviderMetadata } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
  requiresStaleVectorClearResume,
  type EmbeddingModelGateOutcome,
} from './embeddingModelGate.js';
import {
  createEmbeddingGateStatus,
  type EmbeddingGateStatus,
  type GateReevaluateRequest,
} from './gateStatusPublication.js';

/**
 * #440 follow-up — the gate runner: one owner for BOTH gate evaluations.
 *
 * WHY THIS EXISTS. The admin "switch embedding provider" route used to re-run
 * the gate by re-activating the whole knowledge-graph plugin. That path calls
 * `plugin.ts`'s `close()`, which calls `graphPool.end()` — and the kernel
 * captured that pool ONCE (`middleware/src/index.ts`) and shares the reference
 * with ~40 subsystems: routines, dev-platform webhooks, agent schedules, cost
 * telemetry, MCP audit, `AgentGraphStore`, `McpConfigService`. Every one of
 * them answered `Cannot use a pool after calling end on the pool` after a
 * SUCCESSFUL switch, until the process was restarted. A feature whose entire
 * selling point is "no restart" forced one.
 *
 * So the switch leaves the plugin up and asks the gate to re-evaluate itself
 * in place. Nothing is torn down: no pool, no service registration, no store,
 * no job.
 *
 * THE SUBTLE PART — WHICH CLIENT ACTUALLY EMBEDS. `plugin.ts` used to resolve
 * `embeddingClient` once at activation and close over that reference in its
 * resolver. Swap the provider plugin underneath and the registry holds a NEW
 * client while the knowledge-graph still points at the OLD one, so a switch
 * that reports success keeps embedding with the previous provider — silently,
 * because nothing throws. The runner therefore owns `approvedClient()`: the
 * client the CURRENT verdict was computed against. A re-evaluation re-resolves
 * it from the service registry and swaps it in ahead of republishing the
 * verdict, so the instant writes are allowed again they are allowed for the
 * new client.
 *
 * It is deliberately NOT "resolve from the registry on every embed". The gate's
 * job is to keep an unvetted model out of the cosine space; handing out
 * whatever the registry currently holds would let a provider activated outside
 * this path start writing wrong-width vectors against a verdict that still
 * describes the old one. The approved reference moves only when a verdict moves
 * with it.
 *
 * THE OTHER HALF — WHO MAY DESTROY THE CORPUS. `allowDestructiveMigration` is
 * a capability the CALLER hands over per evaluation. `startGateRunner` (the
 * boot path) never hands it over, so a deployment that upgrades and restarts on
 * a width mismatch stays `blocked/column-width-mismatch`: reversible, nothing
 * dropped, operator decides. Only `reevaluate` can hand it over, and only when
 * the operator confirmed the discard in the admin UI AND the KG's
 * `auto_migrate_vector_columns` master switch is not 'false'.
 */

/** Re-arm or stand down the backfill sweep for a freshly published verdict. */
export type BackfillSync = (args: {
  /** The client the new verdict approves, or `undefined` when there is none. */
  client: EmbeddingClient | undefined;
  vectorWritesAllowed: boolean;
  clearResumeOwed: boolean;
}) => void;

export interface GateRunnerDeps {
  pool: Pool;
  tenantId: string;
  /**
   * Resolve `embeddingClient@1` from the SERVICE REGISTRY, right now. Called
   * once per evaluation — never captured — because the whole point of a live
   * switch is that this answer changes under us.
   */
  resolveRegistryClient: () => EmbeddingClient | undefined;
  /**
   * The KG's `auto_migrate_vector_columns` setup field. A MASTER SWITCH, not a
   * boot-path behaviour: 'false' forbids the destructive column rewrite even
   * from a confirmed switch in the admin UI. It can no longer let a restart
   * wipe a corpus, because the boot path never asks for the capability at all.
   */
  autoMigrateVectorColumns: boolean;
  /** Re-arm / stand down the sweep after a re-evaluation. */
  syncBackfill: BackfillSync;
  log: (msg: string) => void;
}

export interface GateRunner {
  /** The object published as `embeddingModelGateStatus`. Stable identity. */
  readonly status: EmbeddingGateStatus;
  /** The verdict currently on display, for the caller's own logging. */
  outcome(): EmbeddingModelGateOutcome;
  /** Is a stale-vector clear still owed under the current verdict? */
  clearResumeOwed(): boolean;
  /** Are vector writes allowed right now? */
  vectorWritesAllowed(): boolean;
  /** The client the current verdict was computed against. */
  approvedClient(): EmbeddingClient | undefined;
  /** Backfill hook — drains an owed clear and re-enables writes in-process. */
  markStaleVectorClearComplete(): void;
  /** Re-run the gate in place. See the module header. */
  reevaluate(request?: GateReevaluateRequest): Promise<EmbeddingGateStatus>;
}

/**
 * The blocked verdict a failed evaluation degrades to.
 *
 * A gate failure must never take activation down with it — the kernel treats
 * `knowledgeGraph` as a required service, so a throw would crash-loop the
 * middleware. No embeddings is recoverable; a boot loop is not.
 */
function gateEvaluationFailed(detail: string): EmbeddingModelGateOutcome {
  return {
    status: 'blocked',
    reason: 'dimension-mismatch',
    modelId: `(gate evaluation failed: ${detail})`,
    dimensions: 0,
    storedModelId: '(unknown)',
    storedDimensions: 0,
  };
}

export async function startGateRunner(deps: GateRunnerDeps): Promise<GateRunner> {
  let approved = deps.resolveRegistryClient();
  let outcome: EmbeddingModelGateOutcome;
  try {
    outcome = await evaluateEmbeddingModelGate({
      pool: deps.pool,
      tenantId: deps.tenantId,
      provider: readEmbeddingProviderMetadata(approved),
      // NOT PASSED ON PURPOSE. A restart may never destroy an embedding
      // corpus; `blocked/column-width-mismatch` is the reversible answer and
      // the operator decides from there. See the module header.
      log: deps.log,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log(
      `[graph-embedding-gate] gate evaluation failed: ${detail} — refusing vector writes for this boot`,
    );
    outcome = gateEvaluationFailed(detail);
  }

  const publication = createEmbeddingGateStatus(
    outcome,
    allowsVectorWrites(outcome),
    requiresStaleVectorClearResume(outcome),
  );

  // Serialises re-evaluations. Two overlapping calls would race the same
  // advisory-locked registry transaction and could publish the older verdict
  // last; chaining is enough because a re-evaluation is operator-paced.
  let chain: Promise<unknown> = Promise.resolve();

  const runReevaluation = async (
    request: GateReevaluateRequest | undefined,
  ): Promise<EmbeddingGateStatus> => {
    // The CURRENT client, from the registry. This line is the fix for the
    // silent failure described in the module header.
    const nextClient = deps.resolveRegistryClient();
    const wanted = request?.allowDestructiveMigration === true;
    const allowed = wanted && deps.autoMigrateVectorColumns;
    if (wanted && !allowed) {
      deps.log(
        "[graph-embedding-gate] the switch confirmed a vector discard, but auto_migrate_vector_columns is 'false' — the columns stay as they are and a width mismatch stays blocked",
      );
    }

    let next: EmbeddingModelGateOutcome;
    try {
      next = await evaluateEmbeddingModelGate({
        pool: deps.pool,
        tenantId: deps.tenantId,
        provider: readEmbeddingProviderMetadata(nextClient),
        allowDestructiveColumnMigration: allowed,
        log: deps.log,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log(
        `[graph-embedding-gate] re-evaluation failed: ${detail} — refusing vector writes until it succeeds`,
      );
      next = gateEvaluationFailed(detail);
    }

    const writesAllowed = allowsVectorWrites(next);
    const clearOwed = requiresStaleVectorClearResume(next);
    // Swap the approved client BEFORE the verdict goes live. The other order
    // leaves a window in which writes are allowed while the resolver still
    // hands out the previous provider's client.
    approved = nextClient;
    publication.republish(next, writesAllowed, clearOwed);
    deps.syncBackfill({
      client: approved,
      vectorWritesAllowed: writesAllowed,
      clearResumeOwed: clearOwed,
    });
    deps.log(
      `[graph-embedding-gate] re-evaluated in place: status=${next.status} writes=${
        writesAllowed ? 'ON' : 'OFF'
      } client=${readEmbeddingProviderMetadata(nextClient)?.modelId ?? '(none)'} destructiveMigration=${
        allowed ? 'permitted' : 'not permitted'
      } — the knowledge-graph plugin and its pool were NOT restarted`,
    );
    outcome = next;
    return { ...publication.status };
  };

  const reevaluate = (
    request?: GateReevaluateRequest,
  ): Promise<EmbeddingGateStatus> => {
    const run = (): Promise<EmbeddingGateStatus> => runReevaluation(request);
    // `then(run, run)` rather than `finally`: a rejected predecessor must not
    // block every later re-evaluation.
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  };

  publication.attachReevaluate(reevaluate);

  return {
    status: publication.status,
    outcome: () => outcome,
    clearResumeOwed: () => requiresStaleVectorClearResume(outcome),
    vectorWritesAllowed: () => publication.vectorWritesAllowed(),
    approvedClient: () => approved,
    markStaleVectorClearComplete: () => { publication.markStaleVectorClearComplete(); },
    reevaluate,
  };
}
