/**
 * Trigger T1 (live hook) — a MemoryStore decorator that promotes every write to
 * the shared `/memories/_rules/` namespace into a curated `manuallyAuthored`
 * MemorableKnowledge, so durable rules the agent authors at runtime reach the
 * always-surface durable recall tier without a manual backfill.
 *
 * Placed OUTSIDE the OrchestratorMemoryNamespacer so it sees the model-facing
 * `/memories/_rules/...` path (the namespacer passes `_` segments through
 * unchanged). The promotion is fire-and-forget: it runs after the inner write
 * resolves and never blocks or fails the write. Idempotent (create-only) via the
 * shared `promoteRuleFileToDurable`.
 */
import type { Pool } from 'pg';
import type {
  KnowledgeGraph,
  MemoryEntry,
  MemoryStore,
} from '@omadia/plugin-api';
import type { EmbeddingClient } from '@omadia/embeddings';
import {
  isDurableRulePath,
  promoteRuleFileToDurable,
} from '@omadia/orchestrator-extras';

export interface DurableRulesHookDeps {
  pool: Pool;
  kg: KnowledgeGraph;
  tenantId: string;
  embeddingClient?: EmbeddingClient;
  log?: (msg: string) => void;
}

export class DurableRulesMemoryStore implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly deps: DurableRulesHookDeps,
  ) {}

  private maybePromote(virtualPath: string, content: string): void {
    if (!isDurableRulePath(virtualPath)) return;
    // Fire-and-forget — never block or fail the originating write.
    void promoteRuleFileToDurable({
      pool: this.deps.pool,
      kg: this.deps.kg,
      tenantId: this.deps.tenantId,
      virtualPath,
      content,
      ...(this.deps.embeddingClient
        ? { embeddingClient: this.deps.embeddingClient }
        : {}),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    }).catch(() => {
      /* promoteRuleFileToDurable already swallows + logs its own errors */
    });
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    await this.inner.createFile(virtualPath, content);
    this.maybePromote(virtualPath, content);
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    await this.inner.writeFile(virtualPath, content);
    this.maybePromote(virtualPath, content);
  }

  // ── Pure pass-throughs ────────────────────────────────────────────────
  list(virtualPath: string): Promise<MemoryEntry[]> {
    return this.inner.list(virtualPath);
  }
  fileExists(virtualPath: string): Promise<boolean> {
    return this.inner.fileExists(virtualPath);
  }
  directoryExists(virtualPath: string): Promise<boolean> {
    return this.inner.directoryExists(virtualPath);
  }
  readFile(virtualPath: string): Promise<string> {
    return this.inner.readFile(virtualPath);
  }
  delete(virtualPath: string): Promise<void> {
    return this.inner.delete(virtualPath);
  }
  rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    return this.inner.rename(fromVirtualPath, toVirtualPath);
  }
}
