/**
 * #578 Phase 3 — the durable {@link CredentialAskStore}.
 *
 * Same non-owning, throw-on-failure conventions as `PostgresCredentialStore`
 * and `PostgresGrantStore`. The one place this file departs from "just
 * issue queries against the shared pool" is {@link approve}: claiming the
 * ask and creating its grant must not be observable half-done (an ask
 * marked `approved` with no grant behind it is a promise the broker cannot
 * keep), so that method checks out its own client and runs both writes in
 * one transaction. Every other method uses the pool directly, same as the
 * rest of this package.
 */

import type { Pool, PoolClient } from 'pg';

import {
  canonicalizePrincipalRef,
  principalRef,
  validateNewGrantInput,
  type CredentialGrantMode,
  type Principal,
} from '@omadia/channel-sdk';

import {
  validateNewAskInput,
  type CredentialAsk,
  type CredentialAskId,
  type CredentialAskStatus,
  type CredentialAskStore,
  type NewCredentialAskInput,
} from './asks.js';

interface AskRow {
  id: string;
  credential_id: string;
  requester_kind: 'user' | 'role';
  requester_ref: string;
  owner_kind: 'user' | 'role';
  owner_ref: string;
  purpose: string;
  mode: CredentialGrantMode;
  requested_grant_expires_at: Date | null;
  ask_expires_at: Date;
  status: CredentialAskStatus;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  grant_id: string | null;
}

const COLUMNS = `id, credential_id, requester_kind, requester_ref, owner_kind, owner_ref,
       purpose, mode, requested_grant_expires_at, ask_expires_at, status,
       created_at, resolved_at, resolved_by, grant_id`;

function rowToAsk(row: AskRow): CredentialAsk {
  const requester: Principal =
    row.requester_kind === 'user' ? { kind: 'user', userId: row.requester_ref } : { kind: 'role', roleKey: row.requester_ref };
  const owner: Principal =
    row.owner_kind === 'user' ? { kind: 'user', userId: row.owner_ref } : { kind: 'role', roleKey: row.owner_ref };
  return {
    id: row.id,
    credentialId: row.credential_id,
    requester,
    owner,
    purpose: row.purpose,
    mode: row.mode,
    requestedGrantExpiresAt: row.requested_grant_expires_at ?? undefined,
    askExpiresAt: row.ask_expires_at,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    grantId: row.grant_id ?? undefined,
  };
}

export class PostgresCredentialAskStore implements CredentialAskStore {
  constructor(private readonly pool: Pool) {}

  async createAsk(input: NewCredentialAskInput): Promise<CredentialAsk> {
    validateNewAskInput(input);
    const requesterRef = canonicalizePrincipalRef(input.requester.kind, principalRef(input.requester));
    const ownerRef = canonicalizePrincipalRef(input.owner.kind, principalRef(input.owner));
    try {
      const result = await this.pool.query<AskRow>(
        `INSERT INTO credential_asks (
           credential_id, requester_kind, requester_ref, owner_kind, owner_ref,
           purpose, mode, requested_grant_expires_at, ask_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${COLUMNS}`,
        [
          input.credentialId,
          input.requester.kind,
          requesterRef,
          input.owner.kind,
          ownerRef,
          input.purpose,
          input.mode,
          input.requestedGrantExpiresAt ?? null,
          input.askExpiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('credential ask insert returned no row');
      return rowToAsk(row);
    } catch (err) {
      if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
        throw new Error(`unknown credential: ${input.credentialId}`, { cause: err });
      }
      throw err;
    }
  }

  async getAsk(id: CredentialAskId): Promise<CredentialAsk | undefined> {
    const result = await this.pool.query<AskRow>(`SELECT ${COLUMNS} FROM credential_asks WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? rowToAsk(row) : undefined;
  }

  async listPendingForOwner(owner: Principal, now: Date): Promise<readonly CredentialAsk[]> {
    const ref = canonicalizePrincipalRef(owner.kind, principalRef(owner));
    const result = await this.pool.query<AskRow>(
      `SELECT ${COLUMNS} FROM credential_asks
        WHERE owner_kind = $1 AND owner_ref = $2 AND status = 'pending' AND ask_expires_at > $3
        ORDER BY created_at ASC`,
      [owner.kind, ref, now],
    );
    return result.rows.map(rowToAsk);
  }

  async listForRequester(requester: Principal): Promise<readonly CredentialAsk[]> {
    const ref = canonicalizePrincipalRef(requester.kind, principalRef(requester));
    const result = await this.pool.query<AskRow>(
      `SELECT ${COLUMNS} FROM credential_asks
        WHERE requester_kind = $1 AND requester_ref = $2
        ORDER BY created_at DESC`,
      [requester.kind, ref],
    );
    return result.rows.map(rowToAsk);
  }

  async approve(id: CredentialAskId, resolvedBy: string, now: Date): Promise<CredentialAsk | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic claim: only a still-pending, unexpired-at-`now` ask can be
      // won. `ask_expires_at > $now` compares against the CALLER's clock,
      // never `now()` evaluated server-side against the row itself — the
      // same #709/#710 anchor discipline as `isAskActionable`.
      const claim = await client.query<AskRow>(
        `UPDATE credential_asks
            SET status = 'approved', resolved_at = $2, resolved_by = $3
          WHERE id = $1 AND status = 'pending' AND ask_expires_at > $2
          RETURNING ${COLUMNS}`,
        [id, now, resolvedBy],
      );
      const claimedRow = claim.rows[0];
      if (!claimedRow) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const ask = rowToAsk(claimedRow);

      validateNewGrantInput({
        credentialId: ask.credentialId,
        principal: ask.requester,
        mode: ask.mode,
        purpose: ask.purpose,
        grantedBy: resolvedBy,
        expiresAt: ask.requestedGrantExpiresAt,
      });
      const requesterRef = canonicalizePrincipalRef(ask.requester.kind, principalRef(ask.requester));
      const grantResult = await client.query<{ id: string }>(
        `INSERT INTO credential_grants (
           credential_id, principal_kind, principal_ref, mode, purpose, granted_by, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [ask.credentialId, ask.requester.kind, requesterRef, ask.mode, ask.purpose, resolvedBy, ask.requestedGrantExpiresAt ?? null],
      );
      const grantId = grantResult.rows[0]?.id;
      if (!grantId) throw new Error('credential grant insert returned no row');

      await client.query(`UPDATE credential_asks SET grant_id = $2 WHERE id = $1`, [id, grantId]);
      await client.query('COMMIT');
      return { ...ask, grantId };
    } catch (err) {
      await rollbackSafely(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async deny(id: CredentialAskId, resolvedBy: string, now: Date): Promise<CredentialAsk | undefined> {
    const result = await this.pool.query<AskRow>(
      `UPDATE credential_asks
          SET status = 'denied', resolved_at = $2, resolved_by = $3
        WHERE id = $1 AND status = 'pending' AND ask_expires_at > $2
        RETURNING ${COLUMNS}`,
      [id, now, resolvedBy],
    );
    const row = result.rows[0];
    return row ? rowToAsk(row) : undefined;
  }

  async cancel(id: CredentialAskId, requester: Principal): Promise<boolean> {
    const ref = canonicalizePrincipalRef(requester.kind, principalRef(requester));
    const result = await this.pool.query(
      `UPDATE credential_asks
          SET status = 'cancelled', resolved_at = now()
        WHERE id = $1 AND status = 'pending' AND requester_kind = $2 AND requester_ref = $3`,
      [id, requester.kind, ref],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

async function rollbackSafely(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* the connection may already be unusable; releasing it is what matters */
  }
}
