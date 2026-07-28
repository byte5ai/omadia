/**
 * Usage audit log: who (which key) called what, when. Introduced by issue
 * #438 inside `@omadia/channel-api`, moved here by issue #439.
 *
 * Vault-backed like `apiKeyStore.ts` (no DB migration for v1), stored as one
 * JSON array under a single fixed vault key. Capped at `MAX_ENTRIES` — this
 * is an operator-visible recent-activity trail, not a durable compliance
 * log; a future revision can move it to durable storage if that need shows
 * up. Writes are serialized through an internal promise chain so concurrent
 * requests append rather than clobber each other's read-modify-write.
 */

import type { ApiKeySecretStorage } from './secretStorage.js';

/**
 * `ok` — the request was handled and the handler reported success.
 * `rate_limited` — the key authenticated but was over its per-minute quota;
 *   the handler was never invoked.
 * `forbidden` — the key authenticated but lacked the scope the route
 *   requires (issue #439); the handler was never invoked.
 * `invalid_request` — the key authenticated but the request body failed
 *   schema validation; the handler was never invoked.
 * `error` — the key authenticated, the handler ran, and it failed.
 */
export type AuditStatus = 'ok' | 'rate_limited' | 'forbidden' | 'error' | 'invalid_request';

export interface AuditEntry {
  readonly keyId: string;
  readonly route: string;
  readonly method: string;
  readonly at: number;
  readonly status: AuditStatus;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  list(): Promise<AuditEntry[]>;
}

const VAULT_KEY = 'usage-audit-log';
/** Exported so tests can assert the cap without hardcoding a magic number. */
export const MAX_ENTRIES = 200;

export function createAuditLog(secrets: ApiKeySecretStorage): AuditLog {
  const write = secrets.set;
  if (!write) {
    throw new Error(
      'createAuditLog requires a write-capable SecretsAccessor — declare permissions.secrets.runtime_write in the manifest',
    );
  }

  async function readAll(): Promise<AuditEntry[]> {
    const raw = await secrets.get(VAULT_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
    } catch {
      return [];
    }
  }

  // Serializes append operations so two in-flight requests don't both read
  // the same snapshot and each write back an array missing the other's entry.
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    record(entry) {
      writeQueue = writeQueue
        .then(async () => {
          const current = await readAll();
          const next = [...current, entry].slice(-MAX_ENTRIES);
          await write(VAULT_KEY, JSON.stringify(next));
        })
        // A logging failure must never break the caller's request; the next
        // append still gets a fresh chain link.
        .catch(() => undefined);
      return writeQueue;
    },
    list() {
      return readAll();
    },
  };
}
