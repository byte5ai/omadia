/**
 * Spec 2042 §5.11 / ADR-0019 (#2079) — the kernel's discretion stores
 * (migration 0098): integration declarations, persisted label sets and the
 * flow audit. Implements the agent runtime's `DiscretionPort`.
 *
 * Declarations are read on every tool call, so they are served from a
 * snapshot refreshed every few seconds and after every operator write; a
 * failing refresh keeps the last snapshot. The audit is fire-and-forget and
 * never receives content: label ids and violation codes only.
 */

import type { Pool } from 'pg';

import {
  EVERYONE,
  parseLabelSet,
  readersOf,
  serializeLabelSet,
  UNKNOWN_READERS,
  type DiscretionAuditEntry,
  type DiscretionPort,
  type IntegrationDeclaration,
  type LabelSet,
  type LabelSubjectKind,
  type Readers,
} from '@omadia/orchestrator';

const SNAPSHOT_TTL_MS = 10_000;
const MAX_IDS_PER_LOOKUP = 500;

/**
 * What every integration counts as while the declarations were never read
 * (no database yet, or the first read failed): restricted, readable by
 * nobody known and accepting nothing. Fails closed: an operator's
 * `restricted` must not read as `internal` in a boot window.
 */
const NOT_LOADED: IntegrationDeclaration = {
  sensitivity: 'restricted',
  readership: { readers: UNKNOWN_READERS, acceptsSystems: [], acceptsClassifications: [] },
};

interface ReadershipDbRow {
  integration: string;
  sensitivity: string;
  readers: unknown;
  accepts_systems: string[];
  accepts_classifications: string[];
  updated_by: string;
  updated_at: Date;
}

export interface IntegrationReadershipRow {
  readonly integration: string;
  readonly declaration: IntegrationDeclaration;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface IntegrationReadershipInput {
  readonly sensitivity: 'internal' | 'restricted';
  readonly readers: Readers;
  readonly acceptsSystems: readonly string[];
  readonly acceptsClassifications: readonly string[];
}

/** `everyone` or a set; anything else (also `unknown`) reads as nobody. */
export function parseReadershipReaders(value: unknown): Readers {
  if (value && typeof value === 'object') {
    const v = value as { kind?: unknown; ids?: unknown };
    if (v.kind === 'everyone') return EVERYONE;
    if (v.kind === 'set' && Array.isArray(v.ids) && v.ids.every((id) => typeof id === 'string')) {
      return readersOf(v.ids as string[]);
    }
  }
  return readersOf([]);
}

function mapReadership(row: ReadershipDbRow): IntegrationReadershipRow {
  return {
    integration: row.integration,
    declaration: {
      sensitivity: row.sensitivity === 'restricted' ? 'restricted' : 'internal',
      readership: {
        readers: parseReadershipReaders(row.readers),
        acceptsSystems: row.accepts_systems,
        acceptsClassifications: row.accepts_classifications,
      },
    },
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export class DiscretionStore implements DiscretionPort {
  private snapshot = new Map<string, IntegrationDeclaration>();
  private snapshotAt = 0;
  private loaded = false;
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly poolRef: Pool | (() => Pool | undefined),
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  private get pool(): Pool | undefined {
    return typeof this.poolRef === 'function' ? this.poolRef() : this.poolRef;
  }

  private async refresh(): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    try {
      const rows = await this.listReaderships();
      this.snapshot = new Map(rows.map((r) => [r.integration, r.declaration]));
      this.snapshotAt = Date.now();
      this.loaded = true;
    } catch (err) {
      this.log(`[discretion] declaration refresh failed, keeping the last snapshot: ${String(err)}`);
    }
  }

  async declarationOf(integration: string): Promise<IntegrationDeclaration | undefined> {
    if (Date.now() - this.snapshotAt > SNAPSHOT_TTL_MS) {
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = undefined;
      });
      // The first read waits; later ones answer from the snapshot meanwhile.
      if (this.snapshotAt === 0) await this.refreshing;
    }
    if (!this.loaded) return NOT_LOADED;
    return this.snapshot.get(integration);
  }

  async labelsOf(kind: LabelSubjectKind, ids: readonly string[]): Promise<ReadonlyMap<string, LabelSet>> {
    const pool = this.pool;
    const out = new Map<string, LabelSet>();
    if (!pool || ids.length === 0) return out;
    // In chunks: every id is looked up, none is silently dropped.
    for (let start = 0; start < ids.length; start += MAX_IDS_PER_LOOKUP) {
      const { rows } = await pool.query<{ subject_id: string; labels: unknown }>(
        'SELECT subject_id, labels FROM discretion_labels WHERE subject_kind = $1 AND subject_id = ANY($2::text[])',
        [kind, ids.slice(start, start + MAX_IDS_PER_LOOKUP)],
      );
      for (const row of rows) out.set(row.subject_id, parseLabelSet(row.labels));
    }
    return out;
  }

  async persistLabels(kind: LabelSubjectKind, id: string, agentSlug: string, labels: LabelSet): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    await pool.query(
      `INSERT INTO discretion_labels (subject_kind, subject_id, agent_slug, labels)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (subject_kind, subject_id) DO UPDATE
         SET labels = EXCLUDED.labels, agent_slug = EXCLUDED.agent_slug, updated_at = now()`,
      [kind, id, agentSlug, JSON.stringify(serializeLabelSet(labels))],
    );
  }

  async dropLabels(kind: LabelSubjectKind, id: string): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    await pool.query('DELETE FROM discretion_labels WHERE subject_kind = $1 AND subject_id = $2', [kind, id]);
  }

  audit(entry: DiscretionAuditEntry): void {
    const pool = this.pool;
    if (!pool) return;
    pool
      .query(
        `INSERT INTO discretion_flow_audit (turn_id, agent_slug, egress, target, allowed, labels, violations)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.turnId ?? null,
          entry.agentSlug ?? null,
          entry.egress,
          entry.target ?? null,
          entry.allowed,
          entry.labels,
          entry.violations,
        ],
      )
      .catch((err: unknown) => this.log(`[discretion] audit insert failed: ${String(err)}`));
  }

  // ── operator API ──────────────────────────────────────────────────────

  async listReaderships(): Promise<IntegrationReadershipRow[]> {
    const pool = this.pool;
    if (!pool) return [];
    const { rows } = await pool.query<ReadershipDbRow>(
      'SELECT * FROM integration_readerships ORDER BY integration',
    );
    return rows.map(mapReadership);
  }

  async upsertReadership(
    integration: string,
    input: IntegrationReadershipInput,
    actor: string,
  ): Promise<IntegrationReadershipRow> {
    const pool = this.pool;
    if (!pool) throw new Error('discretion store: no database');
    const { rows } = await pool.query<ReadershipDbRow>(
      `INSERT INTO integration_readerships
         (integration, sensitivity, readers, accepts_systems, accepts_classifications, updated_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (integration) DO UPDATE SET
         sensitivity = EXCLUDED.sensitivity,
         readers = EXCLUDED.readers,
         accepts_systems = EXCLUDED.accepts_systems,
         accepts_classifications = EXCLUDED.accepts_classifications,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        integration,
        input.sensitivity,
        JSON.stringify(input.readers),
        input.acceptsSystems,
        input.acceptsClassifications,
        actor,
      ],
    );
    await this.refresh();
    return mapReadership(rows[0] as ReadershipDbRow);
  }

  async deleteReadership(integration: string): Promise<boolean> {
    const pool = this.pool;
    if (!pool) return false;
    const { rowCount } = await pool.query('DELETE FROM integration_readerships WHERE integration = $1', [
      integration,
    ]);
    await this.refresh();
    return (rowCount ?? 0) > 0;
  }
}
