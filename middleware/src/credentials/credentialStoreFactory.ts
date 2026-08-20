/**
 * #578 Phase 1 — explicit choice of {@link CredentialStore} backend.
 *
 * The prompt that scoped this issue calls out "the vault no-pool case" by
 * name: what happens in in-memory mode must be an explicit, tested decision,
 * not an implicit fallback nobody chose. This factory IS that decision,
 * stated once so every future call site reads the same trade-off instead of
 * re-deriving it:
 *
 *   - **A Postgres pool is available** → {@link PostgresCredentialStore}.
 *     Credentials and grants survive a restart, exactly like the audience
 *     floor's grant store once #737 gave it a durable backing.
 *   - **No pool** → {@link InMemoryCredentialStore}. The keychain still WORKS
 *     within one process — credentials can be created, grants issued and
 *     checked — but everything is lost on restart. That is acceptable for
 *     local dev and for a deployment that has not configured Postgres, and
 *     unacceptable for anything an operator depends on surviving a redeploy;
 *     phase 2 (the broker) is expected to log which backend it got, the same
 *     way `VaultStatusCard`/`vaultStatus.ts` surfaces the vault's master-key
 *     source so an operator notices when they are unintentionally on the
 *     ephemeral path.
 *
 * No auto-detection, no environment-variable-driven mode switch: the caller
 * passes the pool (or `undefined`) it already has, the same shape
 * `index.ts` uses for `audienceGrantStore = graphPool ? new
 * PostgresGrantStore(graphPool) : undefined`.
 */

import type { Pool } from 'pg';

import {
  fingerprintSecret,
  InMemoryCredentialStore,
  type CredentialStore,
} from '@omadia/channel-sdk';

import { sealSecret, unsealSecret } from './crypto.js';
import { PostgresCredentialStore } from './postgresCredentialStore.js';

export interface CredentialStoreChoice {
  readonly store: CredentialStore;
  readonly backend: 'postgres' | 'in-memory';
}

/**
 * @param pool A Postgres pool, or `undefined` when none is configured for
 *   this deployment (in-memory-KG mode).
 * @param masterKey The resolved 32-byte AES key — see
 *   `resolveCredentialMasterKey` in `crypto.ts`. Passed in rather than
 *   resolved here so this factory stays synchronous and testable without
 *   touching the filesystem or environment.
 */
export function createCredentialStore(pool: Pool | undefined, masterKey: Buffer): CredentialStoreChoice {
  const seal = (plaintext: string) => sealSecret(plaintext, masterKey);
  const unseal = (material: Parameters<typeof unsealSecret>[0]) => unsealSecret(material, masterKey);

  if (pool) {
    return {
      store: new PostgresCredentialStore(pool, seal, fingerprintSecret),
      backend: 'postgres',
    };
  }
  return {
    store: new InMemoryCredentialStore(seal, unseal),
    backend: 'in-memory',
  };
}
