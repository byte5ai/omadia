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
 *
 * #1329 — the log is now read: `forKey` backs `GET /admin/keys/:id/usage`,
 * and `lastUsed` backs the "last used" column. `lastUsed` is kept beside the
 * capped entry list (same vault entry, same write) because the cap would
 * otherwise make a quiet key look "never used" once 200 newer requests from
 * other keys pushed its last entry out. The vault entry used to be a bare
 * array; that legacy shape is still read.
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
  /** #1329 — the retained entries for one key, newest first. */
  forKey(keyId: string): Promise<AuditEntry[]>;
  /** #1329 — key id → epoch ms of its latest authenticated request (any
   *  status). Survives the entry cap. */
  lastUsed(): Promise<Readonly<Record<string, number>>>;
  /** #1328 — drop a deleted key's last-used stamp. Its entries stay and age
   *  out under the cap: request history of a revoked (possibly leaked) key
   *  is evidence, not clutter. */
  forget(keyId: string): Promise<void>;
}

interface StoredLog {
  readonly entries: AuditEntry[];
  readonly lastUsed: Record<string, number>;
}

const VAULT_KEY = 'usage-audit-log';
/** The vault entry holding the log — exported so a writer that may touch
 *  only this entry (the kernel's public MCP endpoint) can say so. */
export const USAGE_LOG_VAULT_KEY = VAULT_KEY;

/**
 * Process-wide write queue. Two `AuditLog` instances write the SAME vault
 * entry — `@omadia/channel-api`'s (chat) and the kernel's public MCP endpoint
 * (#1329) — and each does read-modify-write. A queue per instance would let
 * them interleave and drop each other's appends; one queue for the process
 * serializes both. Held on `globalThis` under a registry symbol so it stays
 * ONE queue even when this package is loaded twice (a plugin resolving its
 * own copy, `src` vs `dist`).
 */
const QUEUE_SLOT = Symbol.for('@omadia/api-key-auth/usage-log-write-queue');

interface QueueHolder {
  [QUEUE_SLOT]?: Promise<void>;
}

function enqueueGlobal(task: () => Promise<void>): Promise<void> {
  const holder = globalThis as QueueHolder;
  const next = (holder[QUEUE_SLOT] ?? Promise.resolve())
    .then(task)
    // A logging failure must never break the caller's request; the next
    // append still gets a fresh chain link.
    .catch(() => undefined);
  holder[QUEUE_SLOT] = next;
  return next;
}
/** Exported so tests can assert the cap without hardcoding a magic number. */
export const MAX_ENTRIES = 200;

export function createAuditLog(secrets: ApiKeySecretStorage): AuditLog {
  const write = secrets.set;
  if (!write) {
    throw new Error(
      'createAuditLog requires a write-capable SecretsAccessor — declare permissions.secrets.runtime_write in the manifest',
    );
  }
  // A const binding keeps the narrowing inside the queued closures below.
  const writeLog: (key: string, value: string) => Promise<void> = write;

  async function readAll(): Promise<StoredLog> {
    const raw = await secrets.get(VAULT_KEY);
    if (!raw) return emptyLog();
    try {
      return parseStoredLog(JSON.parse(raw) as unknown);
    } catch {
      return emptyLog();
    }
  }

  // Every write goes through the queue so a `forget` and an append never
  // interleave their read-modify-write.
  function enqueue(mutate: (current: StoredLog) => StoredLog): Promise<void> {
    return enqueueGlobal(async () => {
      const next = mutate(await readAll());
      await writeLog(VAULT_KEY, JSON.stringify(next));
    });
  }


  return {
    record(entry) {
      return enqueue((current) => ({
        entries: [...current.entries, entry].slice(-MAX_ENTRIES),
        lastUsed: {
          ...current.lastUsed,
          [entry.keyId]: Math.max(current.lastUsed[entry.keyId] ?? 0, entry.at),
        },
      }));
    },
    async list() {
      return (await readAll()).entries;
    },
    async forKey(keyId) {
      const { entries } = await readAll();
      return entries.filter((e) => e.keyId === keyId).reverse();
    },
    async lastUsed() {
      return (await readAll()).lastUsed;
    },
    forget(keyId) {
      return enqueue((current) => {
        const { [keyId]: _dropped, ...lastUsed } = current.lastUsed;
        return { entries: current.entries, lastUsed };
      });
    },
  };
}

function emptyLog(): StoredLog {
  return { entries: [], lastUsed: {} };
}

/** Reads the current `{entries, lastUsed}` shape and the pre-#1329 bare
 *  array (whose `lastUsed` is rebuilt from the entries it still holds). */
function parseStoredLog(parsed: unknown): StoredLog {
  if (Array.isArray(parsed)) {
    const entries = parsed as AuditEntry[];
    return { entries, lastUsed: lastUsedFrom(entries) };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { entries?: unknown; lastUsed?: unknown };
    const entries = Array.isArray(obj.entries) ? (obj.entries as AuditEntry[]) : [];
    const lastUsed =
      obj.lastUsed && typeof obj.lastUsed === 'object' && !Array.isArray(obj.lastUsed)
        ? sanitizeLastUsed(obj.lastUsed as Record<string, unknown>)
        : lastUsedFrom(entries);
    return { entries, lastUsed };
  }
  return emptyLog();
}

// Null-prototype maps: key ids are uuids from verified records, but a map
// keyed by stored data should never be able to reach `Object.prototype`.
function lastUsedFrom(entries: readonly AuditEntry[]): Record<string, number> {
  const out = Object.create(null) as Record<string, number>;
  for (const e of entries) out[e.keyId] = Math.max(out[e.keyId] ?? 0, e.at);
  return out;
}

function sanitizeLastUsed(raw: Record<string, unknown>): Record<string, number> {
  const out = Object.create(null) as Record<string, number>;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
