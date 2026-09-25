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
 *
 * #778 S1 — askable parity with `InMemoryCredentialAskStore`. `createAsk`
 * used to INSERT and lean on the FK alone, so in Postgres mode an ask could
 * target a `service` or a revoked credential. It now runs in its own
 * transaction too: `SELECT ... FROM credentials ... FOR SHARE`, the shared
 * `assertAskableCredential` / `resolveAskOwner` rules, then the INSERT. The
 * `FOR SHARE` row lock blocks `revokeCredential`'s `UPDATE` until commit, so
 * the credential cannot be revoked between the check and the write.
 * `approve` takes the same lock after its claim and closes the ask as
 * `expired` (no grant) when the credential is no longer askable.
 */

import type { Pool, PoolClient } from 'pg';

import {
  canonicalizePrincipalRef,
  principalRef,
  validateNewGrantInput,
  type CredentialGrantMode,
  type CredentialKind,
  type Principal,
} from '@omadia/channel-sdk';

import {
  CredentialAskRejectedError,
  assertAskableCredential,
  isStillAskable,
  resolveAskOwner,
  validateNewAskInput,
  type AskableCredentialFacts,
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const credential = await selectCredentialFactsForShare(client, input.credentialId);
      if (!credential) {
        throw new CredentialAskRejectedError('unknown_credential', `unknown credential: ${input.credentialId}`);
      }
      assertAskableCredential(credential);
      const owner = resolveAskOwner(credential, input.owner);

      const result = await client.query<AskRow>(
        `INSERT INTO credential_asks (
           credential_id, requester_kind, requester_ref, owner_kind, owner_ref,
           purpose, mode, requested_grant_expires_at, ask_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${COLUMNS}`,
        [
          input.credentialId,
          input.requester.kind,
          requesterRef,
          owner.kind,
          principalRef(owner),
          input.purpose,
          input.mode,
          input.requestedGrantExpiresAt ?? null,
          input.askExpiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('credential ask insert returned no row');
      await client.query('COMMIT');
      return rowToAsk(row);
    } catch (err) {
      await rollbackSafely(client);
      if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
        throw new CredentialAskRejectedError('unknown_credential', `unknown credential: ${input.credentialId}`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getAsk(id: CredentialAskId): Promise<CredentialAsk | undefined> {
    try {
      const result = await this.pool.query<AskRow>(`SELECT ${COLUMNS} FROM credential_asks WHERE id = $1`, [id]);
      const row = result.rows[0];
      return row ? rowToAsk(row) : undefined;
    } catch (err) {
      // A non-uuid id addresses no row (the #1093 `datasets.ts` precedent).
      if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) return undefined;
      throw err;
    }
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

      // #778 S1 — re-check the credential under a share lock (blocks a
      // concurrent revoke until this transaction ends). Revoked or gone
      // since the ask was made: close the ask as `expired`, no grant.
      const credential = await selectCredentialFactsForShare(client, ask.credentialId);
      if (!isStillAskable(credential)) {
        await client.query(`UPDATE credential_asks SET status = 'expired' WHERE id = $1`, [id]);
        await client.query('COMMIT');
        return undefined;
      }

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
    try {
      const result = await this.pool.query(
        `UPDATE credential_asks
            SET status = 'cancelled', resolved_at = now()
          WHERE id = $1 AND status = 'pending' AND requester_kind = $2 AND requester_ref = $3`,
        [id, requester.kind, ref],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) return false;
      throw err;
    }
  }
}

interface CredentialFactsRow {
  id: string;
  kind: CredentialKind;
  owner_kind: string | null;
  owner_ref: string | null;
  revoked_at: Date | null;
}

/**
 * The askability facts of one credential, row-locked `FOR SHARE` for the
 * rest of the caller's transaction. `undefined` when no such credential
 * exists — including a non-uuid id, which Postgres reports as `22P02`.
 * That error aborts the surrounding transaction, which is fine for the one
 * caller that can see it: `createAsk` rejects and rolls back straight away.
 * (`approve` passes the ask's own `credential_id`, a UUID column, so it
 * never hits `22P02`.) Owner mapping is the same as
 * `postgresCredentialStore.ts`'s `rowToCredential`.
 */
async function selectCredentialFactsForShare(
  client: PoolClient,
  credentialId: string,
): Promise<AskableCredentialFacts | undefined> {
  let row: CredentialFactsRow | undefined;
  try {
    const result = await client.query<CredentialFactsRow>(
      `SELECT id, kind, owner_kind, owner_ref, revoked_at FROM credentials WHERE id = $1 FOR SHARE`,
      [credentialId],
    );
    row = result.rows[0];
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) return undefined;
    throw err;
  }
  if (!row) return undefined;
  const owner: Principal | undefined =
    row.owner_kind && row.owner_ref
      ? row.owner_kind === 'user'
        ? { kind: 'user', userId: row.owner_ref }
        : { kind: 'role', roleKey: row.owner_ref }
      : undefined;
  return { id: row.id, kind: row.kind, owner, revokedAt: row.revoked_at ?? undefined };
}

const PG_FOREIGN_KEY_VIOLATION = '23503';
/** Postgres invalid_text_representation — e.g. a non-uuid string for a UUID column. */
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

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
