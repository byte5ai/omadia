/**
 * #578 Phase 1 — the durable {@link CredentialStore}.
 *
 * Same store conventions as `PostgresGrantStore` / `PostgresAttachmentBindingStore`
 * (`middleware/src/audience/`), and for the same reasons:
 *
 *  - **It does not own the pool.** Injected, never closed — issue #665 was one
 *    subsystem calling `close()` on a pool ~40 others shared.
 *  - **It is allowed to throw.** Every method here lets a Postgres error
 *    propagate. A caller that turned a database outage into "no active grant"
 *    would make a real outage indistinguishable from an honest revocation —
 *    the credential equivalent of the trap `resolveCapabilities`'s header
 *    documents for capabilities. The broker (phase 2) is expected to treat a
 *    throw as a refusal, not retry-and-hope.
 *
 * `owner_kind`/`owner_ref` and `principal_kind`/`principal_ref` canonicalise
 * with the same #333-phase-1 rule the audience-grant tables use: user
 * references lower-cased, role keys case-preserved. Both the write and the
 * read path canonicalise — writing through the admin surface and reading
 * through the broker must agree, or a grant written for `Alice@Example.com`
 * silently stops matching a lookup for `alice@example.com`.
 */

import type { Pool } from 'pg';

import {
  canonicalizePrincipalRef,
  isGrantActive,
  principalRef,
  validateNewGrantInput,
  type Credential,
  type CredentialBrokerDeclaration,
  type CredentialGrant,
  type CredentialGrantId,
  type CredentialId,
  type CredentialStore,
  type EncryptedSecretMaterial,
  type NewCredentialGrantInput,
  type NewCredentialInput,
  type Principal,
} from '@omadia/channel-sdk';

interface CredentialRow {
  id: string;
  name: string;
  kind: 'personal' | 'service';
  owner_kind: string | null;
  owner_ref: string | null;
  fingerprint: string;
  enc_iv: string;
  enc_tag: string;
  enc_ciphertext: string;
  broker_host: string | null;
  broker_injection_scheme: string | null;
  broker_header_name: string | null;
  broker_allowed_methods: string[] | null;
  broker_path_prefixes: string[] | null;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}

interface GrantRow {
  id: string;
  credential_id: string;
  principal_kind: 'user' | 'role';
  principal_ref: string;
  mode: 'once' | 'standing';
  purpose: string;
  granted_by: string;
  granted_at: Date;
  expires_at: Date | null;
  consumed_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}

/** Postgres unique_violation. https://www.postgresql.org/docs/current/errcodes-appendix.html */
const PG_UNIQUE_VIOLATION = '23505';
/** Postgres foreign_key_violation. */
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function rowToCredential(row: CredentialRow): Credential {
  const owner: Principal | undefined =
    row.owner_kind && row.owner_ref
      ? row.owner_kind === 'user'
        ? { kind: 'user', userId: row.owner_ref }
        : { kind: 'role', roleKey: row.owner_ref }
      : undefined;

  const broker: CredentialBrokerDeclaration | undefined = row.broker_host
    ? {
        host: row.broker_host,
        // Non-null by construction: broker_host is only ever written together
        // with the rest of the declaration (see createCredential below).
        injectionScheme: row.broker_injection_scheme as CredentialBrokerDeclaration['injectionScheme'],
        headerName: row.broker_header_name ?? undefined,
        allowedMethods: row.broker_allowed_methods ?? [],
        pathPrefixes: row.broker_path_prefixes ?? [],
      }
    : undefined;

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    owner,
    fingerprint: row.fingerprint,
    broker,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy: row.revoked_by ?? undefined,
  };
}

function rowToGrant(row: GrantRow): CredentialGrant {
  const principal: Principal =
    row.principal_kind === 'user'
      ? { kind: 'user', userId: row.principal_ref }
      : { kind: 'role', roleKey: row.principal_ref };
  return {
    id: row.id,
    credentialId: row.credential_id,
    principal,
    mode: row.mode,
    purpose: row.purpose,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy: row.revoked_by ?? undefined,
  };
}

const CREDENTIAL_COLUMNS = `id, name, kind, owner_kind, owner_ref, fingerprint,
       enc_iv, enc_tag, enc_ciphertext,
       broker_host, broker_injection_scheme, broker_header_name,
       broker_allowed_methods, broker_path_prefixes,
       created_by, created_at, revoked_at, revoked_by`;

const GRANT_COLUMNS = `id, credential_id, principal_kind, principal_ref, mode, purpose,
       granted_by, granted_at, expires_at, consumed_at, revoked_at, revoked_by`;

export class PostgresCredentialStore implements CredentialStore {
  constructor(
    private readonly pool: Pool,
    private readonly seal: (plaintext: string) => EncryptedSecretMaterial,
    private readonly fingerprint: (plaintext: string) => string,
  ) {}

  async createCredential(input: NewCredentialInput): Promise<Credential> {
    const material = this.seal(input.secret);
    const ownerKind = input.owner?.kind ?? null;
    const ownerRef = input.owner ? canonicalizePrincipalRef(input.owner.kind, principalRef(input.owner)) : null;
    const b = input.broker;
    try {
      const result = await this.pool.query<CredentialRow>(
        `INSERT INTO credentials (
           name, kind, owner_kind, owner_ref, fingerprint,
           enc_iv, enc_tag, enc_ciphertext,
           broker_host, broker_injection_scheme, broker_header_name,
           broker_allowed_methods, broker_path_prefixes,
           created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [
          input.name,
          input.kind,
          ownerKind,
          ownerRef,
          this.fingerprint(input.secret),
          material.iv,
          material.tag,
          material.ciphertext,
          b?.host ?? null,
          b?.injectionScheme ?? null,
          b?.headerName ?? null,
          b ? [...b.allowedMethods] : null,
          b ? [...b.pathPrefixes] : null,
          input.createdBy,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('credential insert returned no row');
      return rowToCredential(row);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new Error(`credential name already in use: ${input.name}`, { cause: err });
      }
      throw err;
    }
  }

  async getCredential(id: CredentialId): Promise<Credential | undefined> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToCredential(row) : undefined;
  }

  async getCredentialByName(name: string): Promise<Credential | undefined> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE name = $1 AND revoked_at IS NULL`,
      [name],
    );
    const row = result.rows[0];
    return row ? rowToCredential(row) : undefined;
  }

  async listCredentials(): Promise<readonly Credential[]> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM credentials ORDER BY created_at DESC`,
    );
    return result.rows.map(rowToCredential);
  }

  async revokeCredential(id: CredentialId, revokedBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE credentials SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, revokedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getSecretMaterial(id: CredentialId): Promise<EncryptedSecretMaterial | undefined> {
    const result = await this.pool.query<{ enc_iv: string; enc_tag: string; enc_ciphertext: string }>(
      `SELECT enc_iv, enc_tag, enc_ciphertext FROM credentials WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? { iv: row.enc_iv, tag: row.enc_tag, ciphertext: row.enc_ciphertext } : undefined;
  }

  async createGrant(input: NewCredentialGrantInput): Promise<CredentialGrant> {
    validateNewGrantInput(input);
    const principalKind = input.principal.kind;
    const principalRefValue = canonicalizePrincipalRef(principalKind, principalRef(input.principal));
    try {
      const result = await this.pool.query<GrantRow>(
        `INSERT INTO credential_grants (
           credential_id, principal_kind, principal_ref, mode, purpose,
           granted_by, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING ${GRANT_COLUMNS}`,
        [
          input.credentialId,
          principalKind,
          principalRefValue,
          input.mode,
          input.purpose,
          input.grantedBy,
          input.expiresAt ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('credential grant insert returned no row');
      return rowToGrant(row);
    } catch (err) {
      if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
        throw new Error(`unknown credential: ${input.credentialId}`, { cause: err });
      }
      throw err;
    }
  }

  async getGrant(id: CredentialGrantId): Promise<CredentialGrant | undefined> {
    const result = await this.pool.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM credential_grants WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToGrant(row) : undefined;
  }

  async listGrantsForCredential(credentialId: CredentialId): Promise<readonly CredentialGrant[]> {
    const result = await this.pool.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM credential_grants WHERE credential_id = $1 ORDER BY granted_at DESC`,
      [credentialId],
    );
    return result.rows.map(rowToGrant);
  }

  async listGrantsForPrincipal(principal: Principal): Promise<readonly CredentialGrant[]> {
    const ref = canonicalizePrincipalRef(principal.kind, principalRef(principal));
    const result = await this.pool.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM credential_grants
        WHERE principal_kind = $1 AND principal_ref = $2
        ORDER BY granted_at DESC`,
      [principal.kind, ref],
    );
    return result.rows.map(rowToGrant);
  }

  async revokeGrant(id: CredentialGrantId, revokedBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE credential_grants SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, revokedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markGrantConsumed(id: CredentialGrantId, consumedAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE credential_grants SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL`,
      [id, consumedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async activeGrant(
    credentialId: CredentialId,
    principal: Principal,
    now: Date,
  ): Promise<CredentialGrant | undefined> {
    const ref = canonicalizePrincipalRef(principal.kind, principalRef(principal));
    // Fetch non-revoked candidates and decide "active" with the SAME
    // `isGrantActive` function the in-memory store and the broker use — one
    // definition of "active", not a SQL copy that could drift from it.
    const result = await this.pool.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM credential_grants
        WHERE credential_id = $1 AND principal_kind = $2 AND principal_ref = $3
          AND revoked_at IS NULL
        ORDER BY granted_at DESC`,
      [credentialId, principal.kind, ref],
    );
    for (const row of result.rows) {
      const grant = rowToGrant(row);
      if (isGrantActive(grant, now)) return grant;
    }
    return undefined;
  }
}
