/**
 * Trigger T1 — promote a durable `_rules/` memory-file into the Knowledge-Graph
 * as a curated `manuallyAuthored=true` MemorableKnowledge so the always-surface
 * durable recall tier (B1) can surface it. Shared by the boot/re-seed sync
 * ({@link syncDurableRules}), the backfill script and the write hook so the
 * paths stay identical.
 *
 * The rule follows its file (#1831, ADR-0185): matched on the EXACT path in the
 * first line of the rationale (`source-memory-path: <path>`), a changed file
 * updates the rule text and its embedding, an unchanged one is left alone, and
 * {@link syncDurableRules} removes the rule of a file that is gone.
 * `createMemorableKnowledge` does not embed inline, so we write the
 * `summary + rationale` joint embedding explicitly — matching the Slice-7
 * contract — when an embedding client is given; without one a changed rule's
 * stale vector is cleared so the embedding backfill re-embeds it.
 *
 * Never throws: failures are logged and returned as `{ action: 'error' }` so a
 * fire-and-forget caller (the write hook) can ignore the result.
 */
import type { Pool } from 'pg';
import { SYSTEM_ACTOR_OMADIA_USER_ID, type KnowledgeGraph } from '@omadia/plugin-api';
import type { EmbeddingClient } from '@omadia/embeddings';

import { isUnprotectedNote, stripUnprotectedNoteMarker } from './noteProvenance.js';

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
  /** #1536 — the write came from a turn without a shield, or with a bypassed
   *  tool: stamp the MK so recall under a shield skips it. */
  unprotected?: boolean;
}

export interface PromoteRuleResult {
  /** `skipped`: not a rule path, empty, or the rule already says this. */
  action: 'created' | 'updated' | 'skipped' | 'error';
  mkId?: string;
}

export { SYSTEM_ACTOR_OMADIA_USER_ID };

/** The `source-memory-path:` line a rule's rationale starts with. */
function sourceMarker(virtualPath: string): string {
  return `${SOURCE_MARKER}${virtualPath}`;
}

/** Rule rows of the tenant, by their exact source path (first line). */
const RULE_ROWS_SQL = `
  SELECT external_id,
         substr(split_part(properties->>'rationale', E'\n', 1), ${String(SOURCE_MARKER.length + 1)}) AS path,
         properties->>'summary' AS summary,
         properties->>'rationale' AS rationale,
         COALESCE((properties->>'unprotected')::boolean, false) AS unprotected
    FROM graph_nodes
   WHERE tenant_id = $1
     AND type = 'MemorableKnowledge'
     AND manually_authored = true
     AND starts_with(properties->>'rationale', '${SOURCE_MARKER}${DURABLE_RULES_PREFIX}')`;

interface RuleRow {
  external_id: string;
  path: string;
  summary: string | null;
  rationale: string | null;
  unprotected: boolean;
}

async function writeEmbedding(
  input: PromoteRuleInput,
  mkId: string,
  text: string,
): Promise<void> {
  const vector = input.embeddingClient ? await input.embeddingClient.embed(text) : [];
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
    return;
  }
  // No vector: a stale one would recall the old wording. Clear it so the
  // embedding backfill picks the rule up again.
  await input.pool.query(
    `UPDATE graph_nodes
        SET embedding = NULL, embedding_attempts = 0
      WHERE external_id = $1 AND tenant_id = $2`,
    [mkId, input.tenantId],
  );
}

export async function promoteRuleFileToDurable(
  input: PromoteRuleInput,
): Promise<PromoteRuleResult> {
  const log = input.log ?? ((): void => {});
  try {
    if (!isDurableRulePath(input.virtualPath)) return { action: 'skipped' };
    // #1540 — a rule file read from the raw store (the backfill script) may
    // carry the unprotected-note marker: drop the line, keep the provenance.
    const unprotected = input.unprotected === true || isUnprotectedNote(input.content);
    const trimmed = stripUnprotectedNoteMarker(input.content).trim();
    if (trimmed.length === 0) return { action: 'skipped' };

    const summary =
      trimmed.length > MAX_SUMMARY ? trimmed.slice(0, MAX_SUMMARY) : trimmed;
    const rationale = `${sourceMarker(input.virtualPath)}\n\n${trimmed}`.slice(
      0,
      9900,
    );

    // #1831 — exact path, not a LIKE prefix (`_` is a LIKE wildcard and
    // `a.md` must not match `a.md.bak`).
    const existing = await input.pool.query<RuleRow>(
      `${RULE_ROWS_SQL}
         AND split_part(properties->>'rationale', E'\n', 1) = $2
       LIMIT 1`,
      [input.tenantId, sourceMarker(input.virtualPath)],
    );
    const hit = existing.rows[0];
    if (hit) {
      if (hit.summary === summary && hit.rationale === rationale && hit.unprotected === unprotected) {
        return { action: 'skipped', mkId: hit.external_id };
      }
      await input.pool.query(
        `UPDATE graph_nodes
            SET properties = (properties - 'unprotected')
                  || jsonb_build_object('summary', $1::text, 'rationale', $2::text)
                  || CASE WHEN $3::boolean THEN '{"unprotected": true}'::jsonb ELSE '{}'::jsonb END,
                updated_at = now()
          WHERE external_id = $4 AND tenant_id = $5`,
        [summary, rationale, unprotected, hit.external_id, input.tenantId],
      );
      await writeEmbedding(input, hit.external_id, `${summary}\n\n${rationale}`);
      log(`[durable-rules] updated mk=${hit.external_id} from ${input.virtualPath}`);
      return { action: 'updated', mkId: hit.external_id };
    }

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
      ...(unprotected ? { unprotected: true } : {}),
    });
    const mkId = result.memorableKnowledgeNodeId;
    if (input.embeddingClient) {
      await writeEmbedding(input, mkId, `${summary}\n\n${rationale}`);
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

export interface SyncDurableRulesInput {
  pool: Pool;
  kg: KnowledgeGraph;
  tenantId: string;
  /** Every file under `/memories/_rules/` as the root store holds it now. */
  files: ReadonlyArray<{ readonly virtualPath: string; readonly content: string }>;
  embeddingClient?: EmbeddingClient;
  log?: (msg: string) => void;
}

export interface SyncDurableRulesResult {
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
}

/**
 * #1831 (ADR-0185) — make the rule entries match the rule files: create or
 * update one per file, delete the entry of a file that no longer exists.
 * Run after the seed was written (boot, re-seed purge). Never throws.
 */
export async function syncDurableRules(
  input: SyncDurableRulesInput,
): Promise<SyncDurableRulesResult> {
  const log = input.log ?? ((): void => {});
  const result: SyncDurableRulesResult = { created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0 };
  const paths = new Set<string>();
  for (const file of input.files) {
    if (!isDurableRulePath(file.virtualPath)) continue;
    paths.add(file.virtualPath);
    const res = await promoteRuleFileToDurable({ ...input, virtualPath: file.virtualPath, content: file.content });
    if (res.action === 'created') result.created++;
    else if (res.action === 'updated') result.updated++;
    else if (res.action === 'error') result.failed++;
    else result.unchanged++;
  }
  // No rule file at all is far more likely a missing seed (wrong
  // MEMORY_SEED_DIR, seeding skipped) than an intended "no rules": keep the
  // entries instead of wiping the durable tier on every boot.
  if (paths.size === 0) {
    log('[durable-rules] no rule files found, existing rule entries kept');
    return result;
  }
  let rows: RuleRow[];
  try {
    rows = (await input.pool.query<RuleRow>(RULE_ROWS_SQL, [input.tenantId])).rows;
  } catch (err) {
    log(`[durable-rules] sync could not list rules: ${err instanceof Error ? err.message : String(err)}`);
    return { ...result, failed: result.failed + 1 };
  }
  for (const row of rows) {
    if (paths.has(row.path)) continue;
    if (!input.kg.deleteOwnerlessMemory) {
      log(`[durable-rules] orphan mk=${row.external_id} (${row.path}) kept: the graph cannot delete owner-less memory`);
      result.failed++;
      continue;
    }
    try {
      await input.kg.deleteOwnerlessMemory(row.external_id, {
        actorOmadiaUserId: SYSTEM_ACTOR_OMADIA_USER_ID,
        reason: `rule file ${row.path} no longer exists`,
      });
      result.removed++;
      log(`[durable-rules] removed mk=${row.external_id}: ${row.path} no longer exists`);
    } catch (err) {
      result.failed++;
      log(`[durable-rules] FAILED to remove mk=${row.external_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
