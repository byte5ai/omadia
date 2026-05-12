/**
 * `agentPriorities@1` — capability contract for per-agent block/boost lists.
 *
 * Phase 5 of the Palaia integration (OB-74). The `ContextRetriever` assembler
 * looks up the (block | boost) entries once per turn for the requesting
 * agent (`listForAgent`) and applies them as a filter (`block` → drop) and
 * score multiplier (`boost` → score × weight) on the already-scored hit pool.
 *
 * Provider: `harness-knowledge-graph-neon` (durable, tenant-scoped). A
 * `NoopAgentPrioritiesStore` implementation is co-published here as the
 * default for backends without a persistent layer (in-memory sibling) —
 * the assembler can then always rely on a service without a special-case
 * branch.
 */

export const AGENT_PRIORITIES_SERVICE_NAME = 'agentPriorities';
export const AGENT_PRIORITIES_CAPABILITY = 'agentPriorities@1';

/** Persisted block or boost entry for an agent/entry pair. */
export interface AgentPriorityRecord {
  /** Agent manifest identity (e.g. `de.byte5.agent.calendar`). */
  readonly agentId: string;
  /** `graph_nodes.external_id` (Turn-ID, `Session::scope::time` pattern, etc.). */
  readonly entryExternalId: string;
  /** `'block'` drops the hit entirely, `'boost'` multiplies score × weight. */
  readonly action: 'block' | 'boost';
  /** Score multiplier — only relevant for `action='boost'`. Default 1.3
   *  (palaia-default for `manually_authored`). Ignored for `'block'`. */
  readonly weight: number;
  /** Optional operator note ("blocked because outdated"). */
  readonly reason: string | null;
  /** Last change — ISO-8601 string. */
  readonly updatedAt: string;
}

export type AgentPriorityUpsert = Omit<AgentPriorityRecord, 'updatedAt'>;

/**
 * Service surface that an `agentPriorities@1` provider publishes.
 *
 * Async by contract — the Neon provider issues a SQL query per call,
 * the Noop provider resolves immediately with `[]`. Tenant scoping is
 * *implementation-internal* (the provider holds the `tenantId` from the
 * boot context); consumers only see (agentId, entryExternalId).
 */
export interface AgentPrioritiesStore {
  /** Bulk-load all (block | boost) entries for an agent. Called by the
   *  resolver once per turn — the assembler indexes the result locally
   *  as Map<entryExternalId, AgentPriorityRecord>. */
  listForAgent(agentId: string): Promise<readonly AgentPriorityRecord[]>;

  /** Insert-or-update. Sets `updated_at = NOW()`. */
  upsert(record: AgentPriorityUpsert): Promise<void>;

  /** Hard-DELETE of an agent/entry entry. No-op when not present. */
  remove(agentId: string, entryExternalId: string): Promise<void>;
}

/**
 * No-op default — published by backends without a persistent layer
 * (in-memory-KG, boot-without-migration). Consumers do not need a
 * special-case branch.
 */
export class NoopAgentPrioritiesStore implements AgentPrioritiesStore {
  async listForAgent(_agentId: string): Promise<readonly AgentPriorityRecord[]> {
    return [];
  }

  async upsert(_record: AgentPriorityUpsert): Promise<void> {
    // intentional no-op
  }

  async remove(_agentId: string, _entryExternalId: string): Promise<void> {
    // intentional no-op
  }
}
