/**
 * Trigger T1 — promote a durable `_rules/` memory-file into the Knowledge-Graph
 * as a curated `manuallyAuthored=true` MemorableKnowledge so the always-surface
 * durable recall tier (B1) can surface it. Shared by BOTH the one-shot backfill
 * script and the live memory-write hook so the two paths stay identical.
 *
 * Idempotent (create-only): if a durable MK already carries this file's
 * `source-memory-path:` marker, it is left untouched. `createMemorableKnowledge`
 * does not embed inline, so we write the `summary + rationale` joint embedding
 * explicitly — matching the Slice-7 contract — when an embedding client is given.
 *
 * Never throws: failures are logged and returned as `{ action: 'error' }` so a
 * fire-and-forget caller (the write hook) can ignore the result.
 */
import type { Pool } from 'pg';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import type { EmbeddingClient } from '@omadia/embeddings';

/** Model-facing prefix for the shared, repo-curated rules namespace. */
export const DURABLE_RULES_PREFIX = '/memories/_rules/';
const SOURCE_MARKER = 'source-memory-path: ';
const MAX_SUMMARY = 1900; // MemorableKnowledge.summary hard cap is 2000.

/** True for paths that should become durable MK (skips the README index). */
export function isDurableRulePath(virtualPath: string): boolean {
  return (
    virtualPath.startsWith(DURABLE_RULES_PREFIX) &&
    !/\/README\.md$/i.test(virtualPath)
  );
}

export interface PromoteRuleInput {
  pool: Pool;
  kg: KnowledgeGraph;
  tenantId: string;
  virtualPath: string;
  content: string;
  /** When given, the summary+rationale joint embedding is written so the MK is
   *  immediately reachable by searchMemorableKnowledgeByEmbedding. */
  embeddingClient?: EmbeddingClient;
  log?: (msg: string) => void;
}

export interface PromoteRuleResult {
  action: 'created' | 'skipped' | 'error';
  mkId?: string;
}

export async function promoteRuleFileToDurable(
  input: PromoteRuleInput,
): Promise<PromoteRuleResult> {
  const log = input.log ?? ((): void => {});
  try {
    if (!isDurableRulePath(input.virtualPath)) return { action: 'skipped' };
    const trimmed = input.content.trim();
    if (trimmed.length === 0) return { action: 'skipped' };

    // Idempotency (create-only): already promoted? matched on the source marker.
    const existing = await input.pool.query<{ external_id: string }>(
      `SELECT external_id FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'MemorableKnowledge'
          AND manually_authored = true
          AND properties->>'rationale' LIKE $2 || '%'
        LIMIT 1`,
      [input.tenantId, SOURCE_MARKER + input.virtualPath],
    );
    if (existing.rows.length > 0) {
      return { action: 'skipped', mkId: existing.rows[0]!.external_id };
    }

    const summary =
      trimmed.length > MAX_SUMMARY ? trimmed.slice(0, MAX_SUMMARY) : trimmed;
    const rationale = `${SOURCE_MARKER}${input.virtualPath}\n\n${trimmed}`.slice(
      0,
      9900,
    );

    const result = await input.kg.createMemorableKnowledge({
      kind: 'reference',
      summary,
      rationale,
      manuallyAuthored: true,
      significance: 1,
      createdBy: 'system:rules-hook',
      involvedOmadiaUserIds: [],
      aclOwners: [], // team-visible curated rule (no per-user ownership)
      visibility: 'team',
    });
    const mkId = result.memorableKnowledgeNodeId;

    if (input.embeddingClient) {
      const vector = await input.embeddingClient.embed(
        `${summary}\n\n${rationale}`,
      );
      if (vector.length > 0) {
        await input.pool.query(
          `UPDATE graph_nodes
              SET embedding = $1::vector,
                  embedding_attempts = 0,
                  embedding_last_error_at = NULL,
                  embedding_last_error = NULL
            WHERE external_id = $2 AND tenant_id = $3`,
          [`[${vector.join(',')}]`, mkId, input.tenantId],
        );
      }
    }
    log(`[durable-rules] created mk=${mkId} from ${input.virtualPath}`);
    return { action: 'created', mkId };
  } catch (err) {
    log(
      `[durable-rules] FAILED ${input.virtualPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { action: 'error' };
  }
}
