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
 *    the web UI's chat copies, the operator audit, a plugin's `ctx.memory`
 *    (the agent tree's `plugins/` and the legacy `/memories/agents/` tree:
 *    machine-read and returned raw to the plugin) or `_brand/` (parsed by
 *    the diagram tool);
 *  - rule promotions (`system:rules-hook`), raw MCP results (`MCP … · …`,
 *    `auto:` authors) and scratch-reaper memories derived from notes, in the
 *    knowledge graph;
 *  - stored processes.
 *
 * Notes are selected by `created_at`: an edit after the cutoff by a protected
 * turn adds no marker and must not hide the legacy content it kept. Not
 * transactional: an abort leaves the items marked so far marked, and a rerun
 * picks up the rest.
 *
 * Idempotent: a marked note and a stamped node or process are skipped. A
 * detector failure aborts the run (`ProvenanceDetectorError`) instead of
 * guessing either way. Dry run unless `apply` is set.
 */

import type { Pool } from 'pg';

import { isUnprotectedNote, markUnprotectedNote } from './noteProvenance.js';

/**
 * Why the text holds a value the shield would have masked (e.g. `c0`, `c1`),
 * logged with the item for the operator's review; `undefined` for no hit.
 */
export type ProvenanceDetector = (text: string) => Promise<string | undefined>;

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
  /** Flagged item → the detector that hit. */
  readonly reasons: Readonly<Record<string, string>>;
  /** Flagged notes that changed between read and write, left unmarked. */
  readonly skippedChanged: readonly string[];
}

export interface ProvenanceBackfillResult {
  readonly applied: boolean;
  readonly notes: ProvenanceBackfillScope;
  readonly ruleMemories: ProvenanceBackfillScope;
  readonly mcpMemories: ProvenanceBackfillScope;
  readonly scratchMemories: ProvenanceBackfillScope;
  readonly processes: ProvenanceBackfillScope;
}

/** SQL filter for the notes the pass may touch (see the module header). */
const NOTE_FILTER = `virtual_path LIKE '/memories/%'
        AND virtual_path ~* '\\.(md|txt)$'
        AND virtual_path !~ '^/memories/(sessions|chat-sessions|core/audit|agents|_brand)/'
        AND virtual_path !~ '^/memories/orchestrators/[^/]+/plugins/'`;

/** `properties.unprotected` is not JSON `true` (tolerates any other value). */
const NOT_STAMPED = `(properties->'unprotected') IS DISTINCT FROM 'true'::jsonb`;

async function flag(
  detect: ProvenanceDetector,
  item: string,
  text: string,
): Promise<string | undefined> {
  try {
    return await detect(text);
  } catch (err) {
    throw new ProvenanceDetectorError(item, err);
  }
}

async function backfillNotes(o: ProvenanceBackfillOptions): Promise<ProvenanceBackfillScope> {
  const rows = await o.pool.query<{ virtual_path: string; content: string }>(
    `SELECT virtual_path, content FROM memory_files
      WHERE ${NOTE_FILTER} AND created_at < $1
      ORDER BY virtual_path`,
    [o.before],
  );
  let scanned = 0;
  const flagged: string[] = [];
  const reasons: Record<string, string> = {};
  const skippedChanged: string[] = [];
  for (const row of rows.rows) {
    if (isUnprotectedNote(row.content)) continue;
    scanned += 1;
    const reason = await flag(o.detect, row.virtual_path, row.content);
    if (reason === undefined) continue;
    if (o.apply) {
      const marked = markUnprotectedNote(row.content);
      // updated_at is kept: the note was not edited, only classified.
      const res = await o.pool.query(
        `UPDATE memory_files SET content = $2, size_bytes = $3
          WHERE virtual_path = $1 AND content = $4`,
        [row.virtual_path, marked, Buffer.byteLength(marked, 'utf8'), row.content],
      );
      if (res.rowCount !== 1) {
        skippedChanged.push(row.virtual_path);
        continue;
      }
    }
    flagged.push(row.virtual_path);
    reasons[row.virtual_path] = reason;
  }
  return { scanned, flagged, reasons, skippedChanged };
}

async function backfillMemories(
  o: ProvenanceBackfillOptions,
  where: string,
): Promise<ProvenanceBackfillScope> {
  const rows = await o.pool.query<{ external_id: string; summary: string | null; rationale: string | null }>(
    `SELECT external_id, properties->>'summary' AS summary, properties->>'rationale' AS rationale
       FROM graph_nodes
      WHERE tenant_id = $1 AND type = 'MemorableKnowledge' AND created_at < $2
        AND ${NOT_STAMPED}
        AND ${where}
      ORDER BY external_id`,
    [o.tenantId, o.before],
  );
  const flagged: string[] = [];
  const reasons: Record<string, string> = {};
  for (const row of rows.rows) {
    const text = `${row.summary ?? ''}\n${row.rationale ?? ''}`;
    const reason = await flag(o.detect, row.external_id, text);
    if (reason === undefined) continue;
    flagged.push(row.external_id);
    reasons[row.external_id] = reason;
    if (o.apply) {
      await o.pool.query(
        `UPDATE graph_nodes
            SET properties = properties || '{"unprotected": true}'::jsonb
          WHERE tenant_id = $1 AND external_id = $2 AND type = 'MemorableKnowledge'`,
        [o.tenantId, row.external_id],
      );
    }
  }
  return { scanned: rows.rows.length, flagged, reasons, skippedChanged: [] };
}

async function backfillProcesses(o: ProvenanceBackfillOptions): Promise<ProvenanceBackfillScope> {
  const rows = await o.pool.query<{ id: string; title: string; steps: unknown }>(
    `SELECT id, title, steps FROM processes
      WHERE tenant_id = $1 AND created_at < $2 AND unprotected = FALSE
      ORDER BY id`,
    [o.tenantId, o.before],
  );
  const flagged: string[] = [];
  const reasons: Record<string, string> = {};
  for (const row of rows.rows) {
    const steps = Array.isArray(row.steps) ? row.steps.filter((s) => typeof s === 'string') : [];
    const reason = await flag(o.detect, row.id, [row.title, ...steps].join('\n'));
    if (reason === undefined) continue;
    flagged.push(row.id);
    reasons[row.id] = reason;
    if (o.apply) {
      await o.pool.query(
        `UPDATE processes SET unprotected = TRUE WHERE tenant_id = $1 AND id = $2`,
        [o.tenantId, row.id],
      );
    }
  }
  return { scanned: rows.rows.length, flagged, reasons, skippedChanged: [] };
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
  const scratchMemories = await backfillMemories(o, `properties->>'created_by' = 'scratch-reaper'`);
  const processes = await backfillProcesses(o);
  const scopes = { notes, ruleMemories, mcpMemories, scratchMemories, processes };
  const result = { applied: o.apply, ...scopes };
  for (const [name, scope] of Object.entries(scopes)) {
    log(
      `[provenance-backfill] ${name}: scanned=${String(scope.scanned)} ${o.apply ? 'marked' : 'would-mark'}=${String(scope.flagged.length)}` +
        (scope.skippedChanged.length > 0 ? ` skipped-changed=${String(scope.skippedChanged.length)}` : ''),
    );
    for (const item of scope.flagged) log(`  - ${item} (${scope.reasons[item] ?? '?'})`);
    for (const item of scope.skippedChanged) log(`  ! ${item} changed during the run, left unmarked`);
  }
  return result;
}
