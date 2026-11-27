// ADR-0300 — Postgres store of the Entra-fed directory of people
// (`directory_people`, `directory_sync_state`, migration 0123). Written only by
// the kernel's directory sync; read by the turn path (person keys), the link
// picker and the admin view.

import type { Pool } from 'pg';

import type { DirectorySourceKind } from '@omadia/channel-sdk';

export type DirectoryPersonStatus = 'active' | 'deprovisioned';

export interface DirectoryPerson {
  readonly id: string;
  readonly source: DirectorySourceKind;
  readonly tenantId: string;
  /** Entra: the AAD object id. Also the person key of per-person tokens. */
  readonly externalId: string;
  readonly upn: string | null;
  readonly mail: string | null;
  readonly displayName: string;
  readonly accountEnabled: boolean;
  readonly status: DirectoryPersonStatus;
  readonly firstSeenAt: Date;
  readonly syncedAt: Date;
  readonly deprovisionedAt: Date | null;
}

export interface DirectorySyncState {
  readonly source: DirectorySourceKind;
  readonly tenantId: string;
  readonly deltaCursor: string | null;
  readonly lastStartedAt: Date | null;
  readonly lastCompletedAt: Date | null;
  readonly lastFullAt: Date | null;
  readonly lastError: string | null;
}

/** What one change writes; `undefined` fields keep the stored value. */
export interface DirectoryPersonUpsert {
  readonly externalId: string;
  readonly displayName?: string;
  readonly upn?: string;
  readonly mail?: string;
  readonly accountEnabled?: boolean;
}

export interface DirectoryListQuery {
  readonly search?: string;
  readonly status?: DirectoryPersonStatus;
  readonly limit?: number;
  readonly offset?: number;
}

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

interface PersonRow {
  id: string;
  source: DirectorySourceKind;
  tenant_id: string;
  external_id: string;
  upn: string | null;
  mail: string | null;
  display_name: string;
  account_enabled: boolean;
  status: DirectoryPersonStatus;
  first_seen_at: Date;
  synced_at: Date;
  deprovisioned_at: Date | null;
}

/**
 * A deprovisioned person turns active again only on positive evidence: the
 * source says the account is enabled (`$7` true), or a full read (`$8` run id)
 * lists them while enabled. A delta that only renames someone does not.
 */
const REACTIVATES = `(directory_people.status = 'deprovisioned' AND ($7 IS TRUE OR ($8::uuid IS NOT NULL AND COALESCE($7, directory_people.account_enabled))))`;

const PERSON_COLUMNS =
  'id, source, tenant_id, external_id, upn, mail, display_name, account_enabled, status, first_seen_at, synced_at, deprovisioned_at';

function toPerson(row: PersonRow): DirectoryPerson {
  return {
    id: row.id,
    source: row.source,
    tenantId: row.tenant_id,
    externalId: row.external_id,
    upn: row.upn,
    mail: row.mail,
    displayName: row.display_name,
    accountEnabled: row.account_enabled,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    syncedAt: row.synced_at,
    deprovisionedAt: row.deprovisioned_at,
  };
}

/** Bounded, trimmed text; blank → null. */
function text(value: string | undefined, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

export class DirectoryStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert or update one person. A person whose account is enabled turns
   * `active` again (an Entra re-enable); a disabled one is left for
   * {@link markDeprovisioned}, which the sync calls with the audit first.
   * `runId` marks the person as seen by a full read.
   */
  async upsert(
    source: DirectorySourceKind,
    tenantId: string,
    change: DirectoryPersonUpsert,
    runId: string | null,
  ): Promise<{ person: DirectoryPerson; reactivated: boolean }> {
    const displayName = text(change.displayName, 256);
    const res = await this.pool.query<PersonRow & { was_status: DirectoryPersonStatus | null }>(
      `WITH prev AS (
         SELECT status FROM directory_people WHERE source = $1 AND tenant_id = $2 AND external_id = $3
       )
       INSERT INTO directory_people (source, tenant_id, external_id, upn, mail, display_name, account_enabled, seen_in_run)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, ''), COALESCE($7, true), $8)
       ON CONFLICT (source, tenant_id, external_id) DO UPDATE SET
         upn = CASE WHEN $9 THEN EXCLUDED.upn ELSE directory_people.upn END,
         mail = CASE WHEN $10 THEN EXCLUDED.mail ELSE directory_people.mail END,
         display_name = COALESCE($6, directory_people.display_name),
         account_enabled = COALESCE($7, directory_people.account_enabled),
         seen_in_run = COALESCE($8, directory_people.seen_in_run),
         synced_at = now(),
         status = CASE WHEN ${REACTIVATES} THEN 'active' ELSE directory_people.status END,
         deprovisioned_at = CASE WHEN ${REACTIVATES} THEN NULL ELSE directory_people.deprovisioned_at END
       RETURNING ${PERSON_COLUMNS}, (SELECT status FROM prev) AS was_status`,
      [
        source,
        tenantId,
        change.externalId,
        text(change.upn, 320) ?? null,
        text(change.mail, 320) ?? null,
        displayName ?? null,
        change.accountEnabled ?? null,
        runId,
        change.upn !== undefined,
        change.mail !== undefined,
      ],
    );
    const row = res.rows[0]!;
    return { person: toPerson(row), reactivated: row.was_status === 'deprovisioned' && row.status === 'active' };
  }

  /** `revokePending`: some connection could not be revoked; the next sync run retries. */
  async markDeprovisioned(id: string, revokePending = false): Promise<void> {
    await this.pool.query(
      `UPDATE directory_people SET status = 'deprovisioned', deprovisioned_at = COALESCE(deprovisioned_at, now()),
              revoke_pending = $2
        WHERE id = $1`,
      [id, revokePending],
    );
  }

  /** Deprovisioned people of a tenant whose token revocation is still pending. */
  async listRevokePending(source: DirectorySourceKind, tenantId: string): Promise<DirectoryPerson[]> {
    const res = await this.pool.query<PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM directory_people
        WHERE source = $1 AND tenant_id = $2 AND status = 'deprovisioned' AND revoke_pending`,
      [source, tenantId],
    );
    return res.rows.map(toPerson);
  }

  async clearRevokePending(id: string): Promise<void> {
    await this.pool.query(`UPDATE directory_people SET revoke_pending = false WHERE id = $1`, [id]);
  }

  async findById(id: string): Promise<DirectoryPerson | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const res = await this.pool.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM directory_people WHERE id = $1`, [id]);
    return res.rows[0] ? toPerson(res.rows[0]) : null;
  }

  async findByExternalId(source: DirectorySourceKind, tenantId: string, externalId: string): Promise<DirectoryPerson | null> {
    const res = await this.pool.query<PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM directory_people WHERE source = $1 AND tenant_id = $2 AND external_id = $3`,
      [source, tenantId, externalId],
    );
    return res.rows[0] ? toPerson(res.rows[0]) : null;
  }

  /** The active person with this object id in any tenant (object ids are globally unique). */
  async findActiveByObjectId(externalId: string): Promise<DirectoryPerson | null> {
    const res = await this.pool.query<PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM directory_people
        WHERE source = 'entra' AND external_id = $1 AND status = 'active'
        ORDER BY synced_at DESC LIMIT 1`,
      [externalId],
    );
    return res.rows[0] ? toPerson(res.rows[0]) : null;
  }

  /** Active people of a tenant that the full read `runId` did not contain. */
  async listUnseenActive(source: DirectorySourceKind, tenantId: string, runId: string): Promise<DirectoryPerson[]> {
    const res = await this.pool.query<PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM directory_people
        WHERE source = $1 AND tenant_id = $2 AND status = 'active'
          AND (seen_in_run IS DISTINCT FROM $3::uuid)`,
      [source, tenantId, runId],
    );
    return res.rows.map(toPerson);
  }

  async list(query: DirectoryListQuery = {}): Promise<{ people: DirectoryPerson[]; total: number }> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const search = query.search?.trim() ? `%${query.search.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null;
    const where = `WHERE ($1::text IS NULL OR LOWER(display_name) LIKE $1 OR LOWER(COALESCE(upn, '')) LIKE $1 OR LOWER(COALESCE(mail, '')) LIKE $1)
        AND ($2::text IS NULL OR status = $2)`;
    const [rows, count] = await Promise.all([
      this.pool.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS} FROM directory_people ${where}
          ORDER BY status, LOWER(display_name), external_id LIMIT $3 OFFSET $4`,
        [search, query.status ?? null, limit, offset],
      ),
      this.pool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM directory_people ${where}`, [
        search,
        query.status ?? null,
      ]),
    ]);
    return { people: rows.rows.map(toPerson), total: Number(count.rows[0]?.total ?? 0) };
  }

  async getSyncState(source: DirectorySourceKind, tenantId: string): Promise<DirectorySyncState | null> {
    const res = await this.pool.query<{
      source: DirectorySourceKind;
      tenant_id: string;
      delta_cursor: string | null;
      last_started_at: Date | null;
      last_completed_at: Date | null;
      last_full_at: Date | null;
      last_error: string | null;
    }>(`SELECT * FROM directory_sync_state WHERE source = $1 AND tenant_id = $2`, [source, tenantId]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      source: row.source,
      tenantId: row.tenant_id,
      deltaCursor: row.delta_cursor,
      lastStartedAt: row.last_started_at,
      lastCompletedAt: row.last_completed_at,
      lastFullAt: row.last_full_at,
      lastError: row.last_error,
    };
  }

  async listSyncStates(): Promise<DirectorySyncState[]> {
    const res = await this.pool.query<{ source: DirectorySourceKind; tenant_id: string }>(
      `SELECT source, tenant_id FROM directory_sync_state ORDER BY source, tenant_id`,
    );
    const states = await Promise.all(res.rows.map((r) => this.getSyncState(r.source, r.tenant_id)));
    return states.filter((s): s is DirectorySyncState => s !== null);
  }

  async markRunStarted(source: DirectorySourceKind, tenantId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO directory_sync_state (source, tenant_id, last_started_at) VALUES ($1, $2, now())
       ON CONFLICT (source, tenant_id) DO UPDATE SET last_started_at = now()`,
      [source, tenantId],
    );
  }

  /** A completed run: the new cursor, and for a full read its time. */
  async markRunCompleted(source: DirectorySourceKind, tenantId: string, deltaCursor: string, full: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE directory_sync_state SET delta_cursor = $3, last_completed_at = now(), last_error = NULL,
              last_full_at = CASE WHEN $4 THEN now() ELSE last_full_at END
        WHERE source = $1 AND tenant_id = $2`,
      [source, tenantId, deltaCursor, full],
    );
  }

  /** A failed run keeps the old cursor. `clearCursor` forces the next run to read in full. */
  async markRunFailed(source: DirectorySourceKind, tenantId: string, error: string, clearCursor = false): Promise<void> {
    await this.pool.query(
      `UPDATE directory_sync_state SET last_error = $3,
              delta_cursor = CASE WHEN $4 THEN NULL ELSE delta_cursor END
        WHERE source = $1 AND tenant_id = $2`,
      [source, tenantId, error.slice(0, 1000), clearCursor],
    );
  }
}
