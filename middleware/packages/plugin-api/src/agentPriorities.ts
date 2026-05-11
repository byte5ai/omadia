/**
 * `agentPriorities@1` — capability contract für per-Agent Block/Boost-Listen.
 *
 * Phase-5 der Palaia-Integration (OB-74). Der `ContextRetriever`-Assembler
 * lookt einmal pro Turn die (block | boost)-Einträge für den anfragenden
 * Agent auf (`listForAgent`) und wendet sie als Filter (`block` → drop) bzw.
 * Score-Multiplier (`boost` → score × weight) auf den bereits-scorten
 * Hit-Pool an.
 *
 * Provider: `harness-knowledge-graph-neon` (durable, Tenant-scoped). Eine
 * `NoopAgentPrioritiesStore`-Implementierung ist als Default für Backends
 * ohne persistente Schicht (in-memory-Sibling) hier mit-publiziert — der
 * Assembler kann sich dann ohne Sonderfall-Branch jederzeit auf einen
 * Service abstützen.
 */

export const AGENT_PRIORITIES_SERVICE_NAME = 'agentPriorities';
export const AGENT_PRIORITIES_CAPABILITY = 'agentPriorities@1';

/** Persisted Block- oder Boost-Eintrag für ein Agent/Entry-Paar. */
export interface AgentPriorityRecord {
  /** Agent-Manifest-Identity (z.B. `de.byte5.agent.calendar`). */
  readonly agentId: string;
  /** `graph_nodes.external_id` (Turn-ID, `Session::scope::time`-Pattern etc.). */
  readonly entryExternalId: string;
  /** `'block'` droppt den Hit komplett, `'boost'` multipliziert score × weight. */
  readonly action: 'block' | 'boost';
  /** Score-Multiplier — nur relevant für `action='boost'`. Default 1.3
   *  (palaia-default für `manually_authored`). Für `'block'` ignoriert. */
  readonly weight: number;
  /** Optionaler Operator-Hinweis ("blocked weil veraltet"). */
  readonly reason: string | null;
  /** Letzte Änderung — ISO-8601-String. */
  readonly updatedAt: string;
}

export type AgentPriorityUpsert = Omit<AgentPriorityRecord, 'updatedAt'>;

/**
 * Service-Surface, die ein `agentPriorities@1`-Provider published.
 *
 * Async by contract — der Neon-Provider macht eine SQL-Query pro Aufruf,
 * Noop-Provider resolved sofort mit `[]`. Tenant-scoping ist *implementations-
 * intern* (Provider hält den `tenantId` aus dem Boot-Context); Konsumenten
 * sehen nur (agentId, entryExternalId).
 */
export interface AgentPrioritiesStore {
  /** Bulk-load all (block | boost) entries für einen Agent. Wird vom
   *  Resolver einmal pro Turn aufgerufen — der Assembler indiziert das
   *  Ergebnis lokal als Map<entryExternalId, AgentPriorityRecord>. */
  listForAgent(agentId: string): Promise<readonly AgentPriorityRecord[]>;

  /** Insert-or-Update. Setzt `updated_at = NOW()`. */
  upsert(record: AgentPriorityUpsert): Promise<void>;

  /** Hard-DELETE eines Agent/Entry-Eintrags. No-op wenn nicht vorhanden. */
  remove(agentId: string, entryExternalId: string): Promise<void>;
}

/**
 * No-op Default — published von Backends ohne persistente Layer
 * (in-memory-KG, Boot-ohne-Migration). Konsumenten brauchen keinen
 * Sonderfall-Branch.
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
