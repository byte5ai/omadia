import type { Pool } from 'pg';
import type { EmbeddingClient, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';
import {
  DURABLE_RULES_PREFIX,
  syncDurableRules,
  type SyncDurableRulesResult,
} from '@omadia/orchestrator-extras';

/**
 * #1831 (ADR-0185) — rule entries follow the seeded rule files. ADR-0033 makes
 * the seed the only source of rules; this runs where the seed is written (boot
 * after the memory plugin seeded, and after a purge that removed memorable
 * knowledge) and makes the `MemorableKnowledge` rules match the files under
 * `/memories/_rules/`: new file → new rule, changed file → updated rule, gone
 * file → rule deleted.
 */

const RULES_DIR = DURABLE_RULES_PREFIX.replace(/\/$/, '');

export interface RuleFile {
  readonly virtualPath: string;
  readonly content: string;
}

/** Every file below `/memories/_rules`, read from the root store. */
export async function readRuleFiles(store: MemoryStore): Promise<RuleFile[]> {
  if (!(await store.directoryExists(RULES_DIR))) return [];
  const files = new Map<string, string>();
  const seenDirs = new Set<string>();
  const queue = [RULES_DIR];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const entry of await store.list(dir)) {
      if (entry.virtualPath === dir) continue;
      if (entry.isDirectory) queue.push(entry.virtualPath);
      else if (!files.has(entry.virtualPath)) {
        files.set(entry.virtualPath, await store.readFile(entry.virtualPath));
      }
    }
  }
  return [...files].map(([virtualPath, content]) => ({ virtualPath, content }));
}

export interface DurableRulesSyncDeps {
  store: MemoryStore;
  kg: KnowledgeGraph;
  pool: Pool;
  tenantId: string;
  /** Resolved per run: the active embedding provider can change at runtime. */
  embeddingClient?: () => EmbeddingClient | undefined;
  log?: (msg: string) => void;
}

/** One sync run. Never throws; `null` when the rule files could not be read. */
export async function runDurableRulesSync(
  deps: DurableRulesSyncDeps,
): Promise<SyncDurableRulesResult | null> {
  const log = deps.log ?? ((msg: string): void => { console.log(msg); });
  let files: RuleFile[];
  try {
    files = await readRuleFiles(deps.store);
  } catch (err) {
    log(`[durable-rules] sync skipped, rule files unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const embeddingClient = deps.embeddingClient?.();
  const result = await syncDurableRules({
    pool: deps.pool,
    kg: deps.kg,
    tenantId: deps.tenantId,
    files,
    ...(embeddingClient ? { embeddingClient } : {}),
    log,
  });
  log(
    `[durable-rules] sync files=${String(files.length)} created=${String(result.created)} updated=${String(result.updated)} unchanged=${String(result.unchanged)} removed=${String(result.removed)} failed=${String(result.failed)}`,
  );
  return result;
}
