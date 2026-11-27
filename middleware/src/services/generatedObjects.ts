import type { Pool } from 'pg';
import type { GeneratedObjectDeleter, GeneratedObjectsService } from '@omadia/plugin-api';

/**
 * ADR-0187 (#1986) — the kernel's record of generated files.
 *
 * Office and diagram plugins write generated files to their bucket under
 * content-addressed keys. `record` files each key under the producing turn's
 * person and chat (migration 0119, `generated_objects`). A release drops the
 * rows a chat deletion, a user purge or a full purge selects; a key left
 * without any row is deleted through the producer's deleter, and only then
 * its rows go. A producer that is not active (no deleter) or whose delete
 * fails keeps its rows, so the next release retries: pending, never lost.
 */

export interface GeneratedObjectRow {
  readonly storageKey: string;
  readonly producer: string;
  /** '' when the turn had no resolved person. */
  readonly ownerOmadiaUserId: string;
  /** '' when the turn had no chat scope. */
  readonly scope: string;
}

/** What a release selects. `scope` alone or with its owner; `all` for a full purge. */
export type GeneratedObjectFilter =
  | { readonly ownerOmadiaUserId: string }
  | { readonly scope: string; readonly ownerOmadiaUserId?: string }
  | { readonly all: true };

export interface GeneratedObjectStore {
  insert(row: GeneratedObjectRow): Promise<void>;
  select(filter: GeneratedObjectFilter): Promise<GeneratedObjectRow[]>;
  /** Keys (per producer) that keep a row outside `rows`. */
  stillReferenced(rows: readonly GeneratedObjectRow[]): Promise<Set<string>>;
  remove(rows: readonly GeneratedObjectRow[]): Promise<void>;
}

const refKey = (producer: string, storageKey: string): string => `${producer}\u0000${storageKey}`;

export class InMemoryGeneratedObjectStore implements GeneratedObjectStore {
  readonly #rows = new Map<string, GeneratedObjectRow>();

  static #id(r: GeneratedObjectRow): string {
    return [r.storageKey, r.producer, r.ownerOmadiaUserId, r.scope].join('\u0000');
  }

  insert(row: GeneratedObjectRow): Promise<void> {
    this.#rows.set(InMemoryGeneratedObjectStore.#id(row), row);
    return Promise.resolve();
  }

  select(filter: GeneratedObjectFilter): Promise<GeneratedObjectRow[]> {
    return Promise.resolve([...this.#rows.values()].filter((r) => matches(r, filter)));
  }

  stillReferenced(rows: readonly GeneratedObjectRow[]): Promise<Set<string>> {
    const selected = new Set(rows.map((r) => InMemoryGeneratedObjectStore.#id(r)));
    const keys = new Set(rows.map((r) => refKey(r.producer, r.storageKey)));
    const kept = new Set<string>();
    for (const [id, r] of this.#rows) {
      const k = refKey(r.producer, r.storageKey);
      if (keys.has(k) && !selected.has(id)) kept.add(k);
    }
    return Promise.resolve(kept);
  }

  remove(rows: readonly GeneratedObjectRow[]): Promise<void> {
    for (const r of rows) this.#rows.delete(InMemoryGeneratedObjectStore.#id(r));
    return Promise.resolve();
  }
}

function matches(r: GeneratedObjectRow, filter: GeneratedObjectFilter): boolean {
  if ('all' in filter) return true;
  if ('scope' in filter) {
    return r.scope === filter.scope &&
      (filter.ownerOmadiaUserId === undefined || r.ownerOmadiaUserId === filter.ownerOmadiaUserId);
  }
  return r.ownerOmadiaUserId === filter.ownerOmadiaUserId;
}

interface DbRow {
  storage_key: string;
  producer: string;
  owner_omadia_user_id: string;
  scope: string;
}

const fromDb = (r: DbRow): GeneratedObjectRow => ({
  storageKey: r.storage_key,
  producer: r.producer,
  ownerOmadiaUserId: r.owner_omadia_user_id,
  scope: r.scope,
});

/** Postgres side (migration 0119). Does not own the pool; may throw. */
export class PostgresGeneratedObjectStore implements GeneratedObjectStore {
  constructor(private readonly pool: Pool) {}

  async insert(row: GeneratedObjectRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO generated_objects (storage_key, producer, owner_omadia_user_id, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [row.storageKey, row.producer, row.ownerOmadiaUserId, row.scope],
    );
  }

  async select(filter: GeneratedObjectFilter): Promise<GeneratedObjectRow[]> {
    const cols = 'storage_key, producer, owner_omadia_user_id, scope';
    if ('all' in filter) {
      return (await this.pool.query<DbRow>(`SELECT ${cols} FROM generated_objects`)).rows.map(fromDb);
    }
    if ('scope' in filter) {
      const res = await this.pool.query<DbRow>(
        `SELECT ${cols} FROM generated_objects
          WHERE scope = $1 AND ($2::text IS NULL OR owner_omadia_user_id = $2)`,
        [filter.scope, filter.ownerOmadiaUserId ?? null],
      );
      return res.rows.map(fromDb);
    }
    const res = await this.pool.query<DbRow>(
      `SELECT ${cols} FROM generated_objects WHERE owner_omadia_user_id = $1`,
      [filter.ownerOmadiaUserId],
    );
    return res.rows.map(fromDb);
  }

  async stillReferenced(rows: readonly GeneratedObjectRow[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    const res = await this.pool.query<{ producer: string; storage_key: string }>(
      `WITH sel AS (
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
           AS s(storage_key, producer, owner_omadia_user_id, scope)
       )
       SELECT DISTINCT g.producer, g.storage_key
         FROM generated_objects g
        WHERE (g.producer, g.storage_key) IN (SELECT producer, storage_key FROM sel)
          AND (g.storage_key, g.producer, g.owner_omadia_user_id, g.scope) NOT IN (SELECT * FROM sel)`,
      columns(rows),
    );
    return new Set(res.rows.map((r) => refKey(r.producer, r.storage_key)));
  }

  async remove(rows: readonly GeneratedObjectRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.pool.query(
      `DELETE FROM generated_objects g
        USING unnest($1::text[], $2::text[], $3::text[], $4::text[])
          AS s(storage_key, producer, owner_omadia_user_id, scope)
        WHERE g.storage_key = s.storage_key AND g.producer = s.producer
          AND g.owner_omadia_user_id = s.owner_omadia_user_id AND g.scope = s.scope`,
      columns(rows),
    );
  }
}

function columns(rows: readonly GeneratedObjectRow[]): [string[], string[], string[], string[]] {
  return [
    rows.map((r) => r.storageKey),
    rows.map((r) => r.producer),
    rows.map((r) => r.ownerOmadiaUserId),
    rows.map((r) => r.scope),
  ];
}

/** Result of a release. */
export interface GeneratedObjectRelease {
  /** Objects deleted from their bucket. */
  deleted: number;
  /** Records dropped whose object other chats or people still reference. */
  unreferenced: number;
  /** Objects that should go but could not: producer inactive or delete failed. */
  pending: number;
}

/** The turn the kernel files a record under. */
export interface GeneratedObjectTurn {
  readonly ownerOmadiaUserId?: string;
  readonly scope?: string;
}

export interface GeneratedObjectsRegistry extends GeneratedObjectsService {
  /** Objects a release with `filter` would delete or un-reference. */
  count(filter: GeneratedObjectFilter): Promise<{ objects: number; shared: number }>;
  release(filter: GeneratedObjectFilter): Promise<GeneratedObjectRelease>;
  /**
   * #2336 (ADR-0310) — file a key under an explicit person and chat, for a
   * kernel route that stores a file outside a turn (a web-chat upload).
   * Throws when the store fails, so the caller can undo the write.
   */
  recordFor(producer: string, storageKey: string, turn: GeneratedObjectTurn): Promise<void>;
}

export interface GeneratedObjectsRegistryDeps {
  /** Resolved per call: Postgres arrives after the service is provided. */
  store: () => GeneratedObjectStore | undefined;
  currentTurn: () => GeneratedObjectTurn | undefined;
  log?: (msg: string) => void;
}

export function createGeneratedObjectsRegistry(deps: GeneratedObjectsRegistryDeps): GeneratedObjectsRegistry {
  const log = deps.log ?? ((msg: string): void => { console.warn(msg); });
  const deleters = new Map<string, GeneratedObjectDeleter>();

  async function plan(filter: GeneratedObjectFilter): Promise<{
    rows: GeneratedObjectRow[];
    orphans: Map<string, GeneratedObjectRow[]>;
    shared: GeneratedObjectRow[];
  }> {
    const store = deps.store();
    if (!store) return { rows: [], orphans: new Map(), shared: [] };
    const rows = await store.select(filter);
    const kept = await store.stillReferenced(rows);
    const orphans = new Map<string, GeneratedObjectRow[]>();
    const shared: GeneratedObjectRow[] = [];
    for (const row of rows) {
      const k = refKey(row.producer, row.storageKey);
      if (kept.has(k)) shared.push(row);
      else orphans.set(k, [...(orphans.get(k) ?? []), row]);
    }
    return { rows, orphans, shared };
  }

  return {
    async record(producer, storageKey) {
      const store = deps.store();
      if (!store) return;
      const turn = deps.currentTurn();
      try {
        await store.insert({
          storageKey,
          producer,
          ownerOmadiaUserId: turn?.ownerOmadiaUserId ?? '',
          scope: turn?.scope ?? '',
        });
      } catch (err) {
        log(`[generated-objects] record failed producer=${producer}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async recordFor(producer, storageKey, turn) {
      const store = deps.store();
      if (!store) return;
      await store.insert({
        storageKey,
        producer,
        ownerOmadiaUserId: turn.ownerOmadiaUserId ?? '',
        scope: turn.scope ?? '',
      });
    },

    registerDeleter(producer, deleter) {
      if (deleters.has(producer)) {
        throw new Error(`[generated-objects] a deleter for ${producer} is already registered`);
      }
      deleters.set(producer, deleter);
      return () => {
        if (deleters.get(producer) === deleter) deleters.delete(producer);
      };
    },

    async count(filter) {
      const { orphans, shared } = await plan(filter);
      return { objects: orphans.size, shared: new Set(shared.map((r) => refKey(r.producer, r.storageKey))).size };
    },

    async release(filter) {
      const store = deps.store();
      const result: GeneratedObjectRelease = { deleted: 0, unreferenced: 0, pending: 0 };
      if (!store) return result;
      const { orphans, shared } = await plan(filter);
      await store.remove(shared);
      result.unreferenced = new Set(shared.map((r) => refKey(r.producer, r.storageKey))).size;
      for (const rows of orphans.values()) {
        const first = rows[0];
        if (!first) continue;
        const deleter = deleters.get(first.producer);
        if (!deleter) {
          result.pending++;
          continue;
        }
        try {
          await deleter(first.storageKey);
          await store.remove(rows);
          result.deleted++;
        } catch (err) {
          result.pending++;
          log(`[generated-objects] delete failed producer=${first.producer}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return result;
    },
  };
}
