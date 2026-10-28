/**
 * #1540 path 4 — provenance backfill for content stored before its
 * `unprotected` flag existed.
 *
 * Notes, stored processes, rule promotions and raw MCP results written before
 * #1536/#1540 carry no provenance, so under a Privacy Shield they count as
 * protected. Marking all of them would hide every curated rule from shielded
 * turns; marking none leaves a rule that names a person readable in clear.
 * This pass marks the legacy items the privacy guard's own detectors flag:
 * identity shapes (C0: e-mail, IBAN, phone, address, ID number — not dates
 * or amounts, which every convention holds) and, when the C1 sidecar is
 * configured, person names and addresses.
 *
 * Scope (everything stored before `before`, not yet flagged):
 *  - `.md`/`.txt` notes under `/memories/` — never the session transcripts,
 *    the web UI's chat copies, the operator audit or a plugin's `ctx.memory`
 *    (refused under a shield anyway, and its files are machine-read);
 *  - rule promotions (`system:rules-hook`) and raw MCP results
 *    (`MCP … · …`, `auto:` authors) in the knowledge graph;
 *  - stored processes.
 *
 * Idempotent: a marked note and a stamped node or process are skipped. A
 * detector failure aborts the run (`ProvenanceDetectorError`) instead of
 * guessing either way. Dry run unless `apply` is set.
 */

import type { Pool } from 'pg';

import { isUnprotectedNote, markUnprotectedNote } from './noteProvenance.js';

/** True when the text holds a value the shield would have masked. */
export type ProvenanceDetector = (text: string) => Promise<boolean>;

export class ProvenanceDetectorError extends Error {
  constructor(item: string, cause: unknown) {
    super(
      `detection failed for ${item}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ProvenanceDetectorError';
  }
}

export interface ProvenanceBackfillOptions {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly detect: ProvenanceDetector;
  /** Only content stored before this instant is considered. */
  readonly before: Date;
  /** Write the marks; otherwise only report them. */
  readonly apply: boolean;
  readonly log?: (msg: string) => void;
}

export interface ProvenanceBackfillScope {
  readonly scanned: number;
  /** Ids or paths the detectors flagged (marked when `apply`). */
  readonly flagged: readonly string[];
}

export interface ProvenanceBackfillResult {
  readonly applied: boolean;
  readonly notes: ProvenanceBackfillScope;
  readonly ruleMemories: ProvenanceBackfillScope;
  readonly mcpMemories: ProvenanceBackfillScope;
  readonly processes: ProvenanceBackfillScope;
}

/** Note paths the pass never touches (see the module header). */
const EXCLUDED_NOTE_PATH =
  /^\/memories\/(sessions|chat-sessions|core\/audit)\/|^\/memories\/orchestrators\/[^/]+\/plugins\//;
const NOTE_FILE = /\.(md|txt)$/i;

async function flag(
  detect: ProvenanceDetector,
  item: string,
  text: string,
): Promise<boolean> {
  try {
    return await detect(text);
  } catch (err) {
    throw new ProvenanceDetectorError(item, err);
  }
}

async function backfillNotes(o: ProvenanceBackfillOptions): Promise<ProvenanceBackfillScope> {
  const rows = await o.pool.query<{ virtual_path: string; content: string }>(
    `SELECT virtual_path, content FROM memory_files
      WHERE virtual_path LIKE '/memories/%' AND updated_at < $1
      ORDER BY virtual_path`,
    [o.before],
  );
  let scanned = 0;
  const flagged: string[] = [];
  for (const row of rows.rows) {
    if (EXCLUDED_NOTE_PATH.test(row.virtual_path) || !NOTE_FILE.test(row.virtual_path)) continue;
    if (isUnprotectedNote(row.content)) continue;
    scanned += 1;
    if (!(await flag(o.detect, row.virtual_path, row.content))) continue;
    flagged.push(row.virtual_path);
    if (o.apply) {
      const marked = markUnprotectedNote(row.content);
      // updated_at is kept: the note was not edited, only classified.
      await o.pool.query(
        `UPDATE memory_files SET content = $2, size_bytes = $3
          WHERE virtual_path = $1 AND content = $4`,
        [row.virtual_path, marked, Buffer.byteLength(marked, 'utf8'), row.content],
      );
    }
  }
  return { scanned, flagged };
}

async function backfillMemories(
  o: ProvenanceBackfillOptions,
  where: string,
): Promise<ProvenanceBackfillScope> {
  const rows = await o.pool.query<{ external_id: string; summary: string | null; rationale: string | null }>(
    `SELECT external_id, properties->>'summary' AS summary, properties->>'rationale' AS rationale
       FROM graph_nodes
      WHERE tenant_id = $1 AND type = 'MemorableKnowledge' AND created_at < $2
        AND COALESCE((properties->>'unprotected')::boolean, FALSE) = FALSE
        AND ${where}
      ORDER BY external_id`,
    [o.tenantId, o.before],
  );
  const flagged: string[] = [];
  for (const row of rows.rows) {
    const text = `${row.summary ?? ''}\n${row.rationale ?? ''}`;
    if (!(await flag(o.detect, row.external_id, text))) continue;
    flagged.push(row.external_id);
    if (o.apply) {
      await o.pool.query(
        `UPDATE graph_nodes
            SET properties = properties || '{"unprotected": true}'::jsonb
          WHERE tenant_id = $1 AND external_id = $2`,
        [o.tenantId, row.external_id],
      );
    }
  }
  return { scanned: rows.rows.length, flagged };
}

async function backfillProcesses(o: ProvenanceBackfillOptions): Promise<ProvenanceBackfillScope> {
  const rows = await o.pool.query<{ id: string; title: string; steps: unknown }>(
    `SELECT id, title, steps FROM processes
      WHERE tenant_id = $1 AND created_at < $2 AND unprotected = FALSE
      ORDER BY id`,
    [o.tenantId, o.before],
  );
  const flagged: string[] = [];
  for (const row of rows.rows) {
    const steps = Array.isArray(row.steps) ? row.steps.filter((s) => typeof s === 'string') : [];
    if (!(await flag(o.detect, row.id, [row.title, ...steps].join('\n')))) continue;
    flagged.push(row.id);
    if (o.apply) {
      await o.pool.query(
        `UPDATE processes SET unprotected = TRUE WHERE tenant_id = $1 AND id = $2`,
        [o.tenantId, row.id],
      );
    }
  }
  return { scanned: rows.rows.length, flagged };
}

/** Runs every scope; see the module header. */
export async function runProvenanceBackfill(
  o: ProvenanceBackfillOptions,
): Promise<ProvenanceBackfillResult> {
  const log = o.log ?? ((): void => {});
  const notes = await backfillNotes(o);
  const ruleMemories = await backfillMemories(o, `properties->>'created_by' = 'system:rules-hook'`);
  const mcpMemories = await backfillMemories(
    o,
    `properties->>'summary' LIKE 'MCP % · %' AND properties->>'created_by' LIKE 'auto:%'`,
  );
  const processes = await backfillProcesses(o);
  const result = { applied: o.apply, notes, ruleMemories, mcpMemories, processes };
  for (const [name, scope] of Object.entries({ notes, ruleMemories, mcpMemories, processes })) {
    log(
      `[provenance-backfill] ${name}: scanned=${String(scope.scanned)} ${o.apply ? 'marked' : 'would-mark'}=${String(scope.flagged.length)}`,
    );
    for (const item of scope.flagged) log(`  - ${item}`);
  }
  return result;
}
