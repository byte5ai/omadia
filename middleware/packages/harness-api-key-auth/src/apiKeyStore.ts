/**
 * Vault-backed API-key store. Introduced by issue #438 inside
 * `@omadia/channel-api`, moved here by issue #439 (plus per-key scopes) so
 * there is exactly ONE key store in the codebase.
 *
 * Design decision (locked on issue #438): API keys are vault-backed via the
 * owning plugin's OWN `ctx.secrets` namespace — no DB migration for v1. Only
 * the sha256 hash of a key ever lands in the vault (see `apiKeyToken.ts`);
 * the plaintext is returned to the caller exactly once, at `create()` time.
 *
 * Each key is its own vault entry (`key:<uuid>` → JSON `ApiKeyRecord`) rather
 * than one growing blob, so create/revoke touch only their own entry. Reads
 * scale with the number of installed keys (`FileSecretVault`'s own docs cite
 * O(10) keys per agent as the target scale for v1) — acceptable for an
 * operator-managed credential list; a future revision can move to durable
 * storage if that stops being true.
 */

import { randomUUID } from 'node:crypto';

import type { ApiKeyScope } from './apiKeyScopes.js';
import { assertValidScopes, LEGACY_DEFAULT_SCOPES, normalizeScopes } from './apiKeyScopes.js';
import { mintApiKey, verifyApiKey } from './apiKeyToken.js';
import type { ApiKeySecretStorage } from './secretStorage.js';

export interface ApiKeyRecord {
  readonly id: string;
  readonly label?: string;
  /** sha256 hex of the plaintext key. Never exposed outside this module. */
  readonly hash: string;
  readonly rateLimitPerMinute: number;
  /** Capabilities this key may exercise. Always populated on read — a record
   *  persisted before scopes existed (no `scopes` field at all) is normalized
   *  to `LEGACY_DEFAULT_SCOPES`, and a record whose `scopes` field is present
   *  but malformed is normalized to the EMPTY set, so consumers never have to
   *  handle `undefined` and a corrupt record never yields a grant. */
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: number;
  readonly revokedAt?: number;
}

/** `ApiKeyRecord` minus the hash — the shape every caller outside this
 *  module (admin route, tests) is allowed to see. */
export type ApiKeyPublicView = Omit<ApiKeyRecord, 'hash'>;

export interface CreateApiKeyOptions {
  readonly label?: string;
  readonly rateLimitPerMinute?: number;
  /** Omitted → `LEGACY_DEFAULT_SCOPES`, i.e. exactly what a pre-scopes key
   *  could do. Throws on a malformed scope rather than dropping it silently
   *  (see `assertValidScopes`). */
  readonly scopes?: readonly ApiKeyScope[];
}

export interface CreatedApiKey {
  readonly record: ApiKeyPublicView;
  /** Plaintext — returned exactly once. Callers must show/copy it now. */
  readonly token: string;
}

export interface ApiKeyStore {
  create(opts: CreateApiKeyOptions): Promise<CreatedApiKey>;
  list(): Promise<ApiKeyPublicView[]>;
  /** Idempotent: revoking an already-revoked key returns its (unchanged)
   *  view. Returns `undefined` when no key with that id exists. */
  revoke(id: string): Promise<ApiKeyPublicView | undefined>;
  /** Resolves the presented plaintext key to its record — only if a
   *  matching, non-revoked key exists. Every stored hash is compared in
   *  constant time via `verifyApiKey`; no early return keyed off which
   *  record is checked first. */
  verify(token: string): Promise<ApiKeyRecord | undefined>;
}

const VAULT_KEY_PREFIX = 'key:';

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const MIN_RATE_LIMIT_PER_MINUTE = 1;
const MAX_RATE_LIMIT_PER_MINUTE = 6000;

function clampRateLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  return Math.min(
    MAX_RATE_LIMIT_PER_MINUTE,
    Math.max(MIN_RATE_LIMIT_PER_MINUTE, Math.floor(value)),
  );
}

function toPublicView(record: ApiKeyRecord): ApiKeyPublicView {
  const { hash: _hash, ...view } = record;
  return view;
}

/**
 * Every path that deserializes a vault entry funnels through here, so a
 * record written before scopes existed comes back with the legacy default
 * filled in instead of `undefined` leaking into scope checks — and a record
 * whose `scopes` field is present but unreadable comes back denying
 * everything rather than falling back to a grant (see `normalizeScopes`).
 */
function hydrate(raw: unknown): ApiKeyRecord {
  const record = raw as ApiKeyRecord;
  return { ...record, scopes: normalizeScopes((record as { scopes?: unknown }).scopes) };
}

/**
 * Narrows an optional `SecretsAccessor` write method to its non-optional
 * function type. A plain `if (!fn) throw` guard on a captured variable does
 * NOT narrow that variable's type inside nested closures defined afterwards
 * (TypeScript re-widens captured bindings across function boundaries) — this
 * helper gives `write`/`del` below a genuinely non-optional TYPE instead of
 * relying on control-flow narrowing that closures can't see.
 */
function requireWriter<T>(fn: T | undefined, name: string): T {
  if (!fn) {
    throw new Error(
      `createApiKeyStore requires a write-capable SecretsAccessor (missing ${name}) — declare permissions.secrets.runtime_write in the manifest`,
    );
  }
  return fn;
}

/**
 * Builds the store. `secrets` must be write-capable (for a plugin, the
 * manifest declares `permissions.secrets.runtime_write`) — the caller checks
 * this once at wiring time and never mounts the routes at all otherwise, so
 * this throwing here is a programmer error, not a runtime condition callers
 * need to handle.
 */
export function createApiKeyStore(secrets: ApiKeySecretStorage): ApiKeyStore {
  const write = requireWriter(secrets.set, 'set');
  requireWriter(secrets.delete, 'delete');

  async function readRecord(id: string): Promise<ApiKeyRecord | undefined> {
    const raw = await secrets.get(VAULT_KEY_PREFIX + id);
    if (!raw) return undefined;
    try {
      return hydrate(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async function writeRecord(record: ApiKeyRecord): Promise<void> {
    await write(VAULT_KEY_PREFIX + record.id, JSON.stringify(record));
  }

  async function allRecords(): Promise<ApiKeyRecord[]> {
    const vaultKeys = await secrets.keys();
    const records: ApiKeyRecord[] = [];
    for (const vaultKey of vaultKeys) {
      if (!vaultKey.startsWith(VAULT_KEY_PREFIX)) continue;
      const raw = await secrets.get(vaultKey);
      if (!raw) continue;
      try {
        records.push(hydrate(JSON.parse(raw)));
      } catch {
        // Corrupt entry — skip it rather than fail the whole listing.
      }
    }
    return records;
  }

  return {
    async create(opts) {
      const { token, hash } = mintApiKey();
      const record: ApiKeyRecord = {
        id: randomUUID(),
        ...(opts.label ? { label: opts.label } : {}),
        hash,
        rateLimitPerMinute: clampRateLimit(opts.rateLimitPerMinute),
        // At CREATE time an empty array is treated as "not specified" and
        // resolves to the legacy default — and, unlike the read path, that is
        // not a silent grant: the 201 response echoes the scope set that was
        // actually assigned, so an operator sees it immediately. The scope set
        // is then always persisted EXPLICITLY, which is what lets `hydrate`
        // read a missing `scopes` field as "genuinely pre-#439" rather than
        // "written by us and lost".
        scopes:
          opts.scopes && opts.scopes.length > 0
            ? assertValidScopes(opts.scopes)
            : LEGACY_DEFAULT_SCOPES,
        createdAt: Date.now(),
      };
      await writeRecord(record);
      return { record: toPublicView(record), token };
    },

    async list() {
      const records = await allRecords();
      return records
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(toPublicView);
    },

    async revoke(id) {
      const record = await readRecord(id);
      if (!record) return undefined;
      if (record.revokedAt !== undefined) return toPublicView(record);
      const revoked: ApiKeyRecord = { ...record, revokedAt: Date.now() };
      await writeRecord(revoked);
      return toPublicView(revoked);
    },

    async verify(token) {
      if (typeof token !== 'string' || token.length === 0) return undefined;
      const records = await allRecords();
      let match: ApiKeyRecord | undefined;
      // Deliberately do NOT `break`/`return` on the first hit — walk every
      // record so the total work (and therefore the timing signal) doesn't
      // depend on which key, if any, matched.
      for (const record of records) {
        if (record.revokedAt !== undefined) continue;
        if (verifyApiKey(token, record.hash)) match = record;
      }
      return match;
    },
  };
}
