/**
 * #578 Phase 1 — the credential keychain's data model: `Credential` +
 * `CredentialGrant`, and the store contract both are read and written through.
 *
 * ## Why this is not "just another `GrantStore`"
 *
 * The issue frames credential grants as flowing "through the existing
 * `GrantStore` mechanism, not alongside it" (#575's `resolveCapabilities` /
 * `audienceFloor`). That reuse happens at the COARSE layer: the broker (#578
 * phase 2) gates broker use itself behind an ordinary capability
 * (`credential:broker:use`) resolved the normal #575 way, through the SAME
 * `GrantStore` every other capability goes through.
 *
 * What `GrantStore` cannot express is the FINE layer this file owns: a
 * capability grant is a bare boolean ("this principal may `tool:send_email`")
 * with no expiry, no purpose, no once-vs-standing distinction and no per-grant
 * revocation trail. A credential grant needs all four — the issue states them
 * explicitly (audience scope, `once | standing`, purpose, expiry, revocation)
 * — so encoding a `CredentialGrant` as a synthetic capability string would
 * either lose that metadata or smuggle it into the capability string itself,
 * which `resolveCapabilities` treats as opaque and a CHECK constraint would
 * have to parse. A dedicated table is not a parallel grant system; it is the
 * metadata `GrantStore`'s shape has no room for.
 *
 * `CredentialStore` follows the same store conventions #575/#665 established
 * for `GrantStore` and `AttachmentBindingStore`: it does not own its
 * connection, and a store that cannot answer must THROW rather than return an
 * empty/falsy result. A credential lookup that swallowed a database error and
 * reported "no active grant" would be indistinguishable from an honestly
 * absent grant — the exact trap `resolveCapabilities`'s header describes for
 * capabilities, and it matters even more here because the failure mode is
 * "silently deny access to a secret" (safe) mixed with "the broker cannot tell
 * an outage from a real revocation" (an operator-facing regression).
 *
 * ## What lives here vs. later phases
 *
 * Phase 1 (this file + the Postgres/in-memory stores) is data model and
 * storage only — no route, no tool, no broker enforcement. The broker
 * declaration fields (`host`, `injectionScheme`, `allowedMethods`,
 * `pathPrefixes`) are part of a `Credential`'s stored shape because the issue
 * describes them as something a credential DECLARES, but nothing reads or
 * enforces them yet — phase 2 owns path normalisation, prefix matching and the
 * fail-closed egress check.
 */

import { createHash } from 'node:crypto';

import type { Principal, PrincipalKind } from './principal.js';
import { canonicalizePrincipalRef, principalRef } from './principal.js';

/** Opaque identifier for a stored credential. */
export type CredentialId = string;

/** Opaque identifier for a stored grant against a credential. */
export type CredentialGrantId = string;

/**
 * `personal` — owned by a single principal, who is asked before an agent may
 * use it (phase 3, keychain-asks).
 *
 * `service` — an org-wide credential with no single owner; only reachable
 * through the broker (phase 2), which is the only thing ever allowed to see
 * the plaintext.
 */
export type CredentialKind = 'personal' | 'service';

export const CREDENTIAL_KINDS: readonly CredentialKind[] = Object.freeze(['personal', 'service']);

/** How a request may present the secret on the wire. Phase 2 reads this;
 *  phase 1 only stores it. */
export type CredentialInjectionScheme = 'bearer' | 'header' | 'basic-password' | 'query-param';

/**
 * A `service` credential's egress declaration: where it may be sent, and how.
 * Absent for `personal` credentials, which have no broker involvement.
 */
export interface CredentialBrokerDeclaration {
  /** Exact host the secret may be stamped onto (`api.example.com`). No
   *  wildcards — phase 2 compares this literally against the request host. */
  readonly host: string;
  readonly injectionScheme: CredentialInjectionScheme;
  /** Header name for the `header` injection scheme. Ignored otherwise. */
  readonly headerName?: string;
  /** Uppercase HTTP methods the broker may use this credential for. */
  readonly allowedMethods: readonly string[];
  /** Path prefixes (e.g. `/v1/messages`) the broker may use this credential
   *  for. Phase 2 normalises the request path before comparing — this field
   *  only stores the declared prefixes. */
  readonly pathPrefixes: readonly string[];
}

/**
 * A stored credential's metadata. Deliberately carries NO plaintext secret —
 * only a `fingerprint` (a one-way, truncated digest, safe to log) and the
 * store's own encrypted-at-rest material, which lives beside this type in
 * {@link EncryptedSecretMaterial} and is never returned by the same read path
 * as this metadata.
 */
export interface Credential {
  readonly id: CredentialId;
  /** Human label, unique among non-revoked credentials. */
  readonly name: string;
  readonly kind: CredentialKind;
  /** Owning principal. Present for `personal`, absent for `service`. */
  readonly owner?: Principal;
  readonly fingerprint: string;
  readonly broker?: CredentialBrokerDeclaration;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly revokedAt?: Date;
  readonly revokedBy?: string;
}

/** The encrypted-at-rest secret material for one credential. AES-256-GCM,
 *  same envelope shape as the existing secret vault (`fileVault.ts`) — see
 *  `middleware/src/credentials/crypto.ts` for the encrypt/decrypt side. */
export interface EncryptedSecretMaterial {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export type CredentialGrantMode = 'once' | 'standing';

export const CREDENTIAL_GRANT_MODES: readonly CredentialGrantMode[] = Object.freeze([
  'once',
  'standing',
]);

/**
 * One principal's right to use one credential.
 *
 * `expiresAt` is required for `mode: 'once'` (a single-use grant with no TTL
 * is a standing grant wearing a disguise) and optional for `mode: 'standing'`
 * (a standing grant MAY be open-ended). The store enforces this; see
 * {@link validateNewGrantInput}.
 *
 * `consumedAt` is set the first time a `once` grant is redeemed (phase 2/3);
 * phase 1 only carries the column so a later phase does not need a migration
 * to add it.
 */
export interface CredentialGrant {
  readonly id: CredentialGrantId;
  readonly credentialId: CredentialId;
  readonly principal: Principal;
  readonly mode: CredentialGrantMode;
  readonly purpose: string;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly expiresAt?: Date;
  readonly consumedAt?: Date;
  readonly revokedAt?: Date;
  readonly revokedBy?: string;
}

export interface NewCredentialInput {
  readonly name: string;
  readonly kind: CredentialKind;
  readonly owner?: Principal;
  readonly secret: string;
  readonly broker?: CredentialBrokerDeclaration;
  readonly createdBy: string;
}

export interface NewCredentialGrantInput {
  readonly credentialId: CredentialId;
  readonly principal: Principal;
  readonly mode: CredentialGrantMode;
  readonly purpose: string;
  readonly grantedBy: string;
  readonly expiresAt?: Date;
}

/**
 * Validates the two invariants the DB schema also enforces (belt + braces —
 * an in-memory store has no CHECK constraint to fall back on):
 *  - `once` requires an expiry.
 *  - `purpose` must be non-empty: an unexplained standing grant to a secret is
 *    exactly the audit gap the issue exists to close.
 *
 * Throws rather than silently coercing, matching the "a store that cannot
 * honour a write must say so" convention used throughout this module.
 */
export function validateNewGrantInput(input: NewCredentialGrantInput): void {
  if (input.purpose.trim().length === 0) {
    throw new Error('credential grant purpose must not be empty');
  }
  if (input.mode === 'once' && !input.expiresAt) {
    throw new Error('a "once" credential grant requires expiresAt');
  }
}

/**
 * Whether a grant is currently usable, evaluated against a caller-supplied
 * `now` rather than reading the clock internally.
 *
 * This is deliberate, not a style choice: the #709/#710 finding was that
 * anchoring an expiry check to a field on the SAME row under test (or to an
 * implicit `Date.now()` inside the assertion) makes the check racy against
 * mutation timing. Passing `now` in lets a caller (the broker, a test) pin one
 * instant and evaluate every grant against it, so "expired" and "not yet
 * expired" are decided consistently within a single request even if wall-clock
 * time advances mid-evaluation.
 */
export function isGrantActive(grant: CredentialGrant, now: Date): boolean {
  if (grant.revokedAt) return false;
  if (grant.mode === 'once' && grant.consumedAt) return false;
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The store contract for credentials and their grants.
 *
 * Same failure contract as {@link GrantStore} in `grants.ts`: every read/write
 * method is allowed to throw and a caller must not convert that into an empty
 * result. Unlike `GrantStore`, this is not consumed by `resolveCapabilities` —
 * phase 2's broker calls it directly.
 */
export interface CredentialStore {
  createCredential(input: NewCredentialInput): Promise<Credential>;
  getCredential(id: CredentialId): Promise<Credential | undefined>;
  getCredentialByName(name: string): Promise<Credential | undefined>;
  listCredentials(): Promise<readonly Credential[]>;
  /** @returns whether a row was actually revoked, so a caller can 404 honestly. */
  revokeCredential(id: CredentialId, revokedBy: string): Promise<boolean>;
  /** Encrypted material only — never mixed into the same read as metadata, so
   *  a caller that only wants to list credentials never even touches it. */
  getSecretMaterial(id: CredentialId): Promise<EncryptedSecretMaterial | undefined>;

  createGrant(input: NewCredentialGrantInput): Promise<CredentialGrant>;
  getGrant(id: CredentialGrantId): Promise<CredentialGrant | undefined>;
  listGrantsForCredential(credentialId: CredentialId): Promise<readonly CredentialGrant[]>;
  listGrantsForPrincipal(principal: Principal): Promise<readonly CredentialGrant[]>;
  /** @returns whether a row was actually revoked. */
  revokeGrant(id: CredentialGrantId, revokedBy: string): Promise<boolean>;
  /** Marks a `once` grant consumed. No-op-safe to call twice; the second call
   *  returns `false` because nothing changed. */
  markGrantConsumed(id: CredentialGrantId, consumedAt: Date): Promise<boolean>;
  /**
   * The active (unrevoked, unexpired, unconsumed-if-`once`) grant for this
   * principal + credential, evaluated against `now`. `undefined` when none
   * exists — the caller (the broker) treats that as a refusal.
   */
  activeGrant(
    credentialId: CredentialId,
    principal: Principal,
    now: Date,
  ): Promise<CredentialGrant | undefined>;
}

let idCounter = 0;

/** Deterministic-enough id generator for the in-memory store — avoids pulling
 *  `node:crypto` randomUUID into a code path tests may call thousands of times
 *  and keeps ids trivially sortable by creation order in assertions. */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${String(idCounter)}_${String(Date.now())}`;
}

interface StoredCredential extends Credential {
  readonly secretMaterial: EncryptedSecretMaterial;
}

/**
 * An in-memory {@link CredentialStore} for tests and for deployments with no
 * Postgres pool.
 *
 * ## The no-pool trap (explicit, not implicit)
 *
 * Unlike the encrypted file vault, this store does NOT persist to disk. That
 * is a deliberate, explicit decision, not an accidental fallback: a keychain
 * that silently degraded to disk-backed persistence when no pool is
 * configured would be a SECOND encryption-at-rest implementation with its own
 * key-management story, doubling the surface the issue's threat model has to
 * cover. Instead, `createCredentialStore` (in `middleware/src/credentials/`)
 * picks this store only when there is no pool, and callers are expected to
 * treat that as "the keychain is ephemeral for this process" — every
 * credential and grant is lost on restart, exactly like `InMemoryGrantStore`
 * without a `PostgresGrantStore` behind it.
 *
 * Encryption still happens here (the secret is never stored as plaintext even
 * in memory) via the same envelope shape as the file/Postgres stores — the
 * caller supplies an encrypt/decrypt pair (`middleware/src/credentials/
 * crypto.ts`) rather than this module owning key management, so a test store
 * and the production store share exactly one AES-256-GCM implementation.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly grants = new Map<string, CredentialGrant>();

  constructor(
    private readonly seal: (plaintext: string) => EncryptedSecretMaterial,
    private readonly unseal: (material: EncryptedSecretMaterial) => string,
  ) {}

  async createCredential(input: NewCredentialInput): Promise<Credential> {
    const existing = await this.getCredentialByName(input.name);
    if (existing) {
      throw new Error(`credential name already in use: ${input.name}`);
    }
    const id = nextId('cred');
    const secretMaterial = this.seal(input.secret);
    const stored: StoredCredential = {
      id,
      name: input.name,
      kind: input.kind,
      owner: input.owner,
      fingerprint: fingerprintSecret(input.secret),
      broker: input.broker,
      createdBy: input.createdBy,
      createdAt: new Date(),
      secretMaterial,
    };
    this.credentials.set(id, stored);
    return toCredential(stored);
  }

  async getCredential(id: CredentialId): Promise<Credential | undefined> {
    const row = this.credentials.get(id);
    return row ? toCredential(row) : undefined;
  }

  async getCredentialByName(name: string): Promise<Credential | undefined> {
    for (const row of this.credentials.values()) {
      if (row.name === name && !row.revokedAt) return toCredential(row);
    }
    return undefined;
  }

  async listCredentials(): Promise<readonly Credential[]> {
    return Array.from(this.credentials.values()).map(toCredential);
  }

  async revokeCredential(id: CredentialId, revokedBy: string): Promise<boolean> {
    const row = this.credentials.get(id);
    if (!row || row.revokedAt) return false;
    this.credentials.set(id, { ...row, revokedAt: new Date(), revokedBy });
    return true;
  }

  async getSecretMaterial(id: CredentialId): Promise<EncryptedSecretMaterial | undefined> {
    return this.credentials.get(id)?.secretMaterial;
  }

  async createGrant(input: NewCredentialGrantInput): Promise<CredentialGrant> {
    validateNewGrantInput(input);
    if (!this.credentials.has(input.credentialId)) {
      throw new Error(`unknown credential: ${input.credentialId}`);
    }
    const id = nextId('grant');
    const grant: CredentialGrant = {
      id,
      credentialId: input.credentialId,
      principal: input.principal,
      mode: input.mode,
      purpose: input.purpose,
      grantedBy: input.grantedBy,
      grantedAt: new Date(),
      expiresAt: input.expiresAt,
    };
    this.grants.set(id, grant);
    return grant;
  }

  async getGrant(id: CredentialGrantId): Promise<CredentialGrant | undefined> {
    return this.grants.get(id);
  }

  async listGrantsForCredential(credentialId: CredentialId): Promise<readonly CredentialGrant[]> {
    return Array.from(this.grants.values()).filter((g) => g.credentialId === credentialId);
  }

  async listGrantsForPrincipal(principal: Principal): Promise<readonly CredentialGrant[]> {
    return Array.from(this.grants.values()).filter((g) =>
      principalsMatch(g.principal, principal),
    );
  }

  async revokeGrant(id: CredentialGrantId, revokedBy: string): Promise<boolean> {
    const grant = this.grants.get(id);
    if (!grant || grant.revokedAt) return false;
    this.grants.set(id, { ...grant, revokedAt: new Date(), revokedBy });
    return true;
  }

  async markGrantConsumed(id: CredentialGrantId, consumedAt: Date): Promise<boolean> {
    const grant = this.grants.get(id);
    if (!grant || grant.consumedAt) return false;
    this.grants.set(id, { ...grant, consumedAt });
    return true;
  }

  async activeGrant(
    credentialId: CredentialId,
    principal: Principal,
    now: Date,
  ): Promise<CredentialGrant | undefined> {
    for (const grant of this.grants.values()) {
      if (grant.credentialId !== credentialId) continue;
      if (!principalsMatch(grant.principal, principal)) continue;
      if (isGrantActive(grant, now)) return grant;
    }
    return undefined;
  }

  /** Test-only escape hatch to read the decrypted secret without going through
   *  a broker — production code has no equivalent, by design. */
  async unsealForTest(id: CredentialId): Promise<string | undefined> {
    const row = this.credentials.get(id);
    return row ? this.unseal(row.secretMaterial) : undefined;
  }
}

function toCredential(row: StoredCredential): Credential {
  const { secretMaterial: _secretMaterial, ...rest } = row;
  return rest;
}

/** Principal equality using the SAME canonicalisation rule #333 established
 *  (`principalsEqual` in `principal.ts` requires an exact-kind `Principal`
 *  value; this accepts the kind/ref pair the stores read off a row). */
function principalsMatch(a: Principal, b: Principal): boolean {
  if (a.kind !== b.kind) return false;
  const kind: PrincipalKind = a.kind;
  return (
    canonicalizePrincipalRef(kind, principalRef(a)) === canonicalizePrincipalRef(kind, principalRef(b))
  );
}

/**
 * A one-way, truncated fingerprint safe to place in logs, audit events and
 * error messages in place of the secret itself — the log surrogate the issue
 * requires ("secrets never appear in logs/audit events/errors").
 *
 * SHA-256 over the raw secret, hex-encoded and truncated to 16 characters
 * (64 bits) — enough to let an operator visually confirm "this is the same
 * credential I rotated" without materially aiding a brute-force guess (the
 * fingerprint is a digest of the ALREADY-random secret, not a hash of a
 * dictionary-guessable value).
 */
export function fingerprintSecret(secret: string): string {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16)}`;
}
