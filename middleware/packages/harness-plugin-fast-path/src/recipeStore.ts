import { createHash } from 'node:crypto';

import { parseRefreshSource, type RefreshSource } from './refreshRecipes.js';

/**
 * Canvas refresh recipes — the query that filled a table, per canvas session
 * and container. They drive the LLM-free refresh and resolve the record an
 * action turn ("Details" on a row) targets. In-process only, a restart or
 * deploy forgot every table's query; with a plugin memory they now persist:
 *
 *   - one file per canvas session (`canvas-recipes/<sha256(sessionId)>.json`
 *     — the raw id never becomes a path), loaded lazily on that session's
 *     first use and rewritten on every `set`;
 *   - bounded: ≤ `maxContainersPerSession` recipes per session (oldest
 *     dropped) and a global LRU over sessions (`canvas-recipes/index.json`)
 *     that deletes the least recently used sessions' files once more than
 *     `maxEntries` recipes are stored;
 *   - corrupt-tolerant: an unreadable file starts that session (or the index)
 *     empty; a failed write is logged and the in-process recipe still serves.
 *
 * Scope is unchanged from the in-process store: a recipe (tool input — may
 * carry literal filter values of the user's own query) is reachable only
 * under its own canvas session id, never tenant-wide.
 */

export interface RecipeStore {
  /** Load `canvasSessionId`'s persisted recipes (idempotent, never throws).
   *  Call before `get` on a session's first use after a restart. */
  load(canvasSessionId: string): Promise<void>;
  get(canvasSessionId: string, containerId: string): RefreshSource | undefined;
  set(canvasSessionId: string, containerId: string, source: RefreshSource): void;
  /** Resolves once every pending write has settled (tests, shutdown). */
  flush(): Promise<void>;
}

/** The slice of `ctx.memory` the store needs. */
export interface RecipeMemory {
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  delete(relPath: string): Promise<void>;
}

export interface RecipeStoreOptions {
  memory?: RecipeMemory;
  log?: (message: string) => void;
  maxContainersPerSession?: number;
  maxEntries?: number;
}

export const MAX_RECIPES_PER_SESSION = 20;
export const MAX_RECIPE_ENTRIES = 2000;
const RECIPES_DIR = 'canvas-recipes';
const INDEX_PATH = `${RECIPES_DIR}/index.json`;
const SCHEMA_VERSION = 1;

const sessionKey = (canvasSessionId: string): string =>
  createHash('sha256').update(canvasSessionId).digest('hex').slice(0, 40);
const sessionPath = (key: string): string => `${RECIPES_DIR}/${key}.json`;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A Map used as an LRU: touching re-inserts at the end (most recent). */
function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

export function createRecipeStore(opts: RecipeStoreOptions = {}): RecipeStore {
  const memory = opts.memory;
  const log = opts.log ?? ((): void => undefined);
  const maxPerSession = opts.maxContainersPerSession ?? MAX_RECIPES_PER_SESSION;
  const maxEntries = opts.maxEntries ?? MAX_RECIPE_ENTRIES;
  /** session key → containerId → recipe (in-process cache, LRU order) */
  const sessions = new Map<string, Map<string, RefreshSource>>();
  /** session key → recipe count, LRU order (oldest first) — every stored
   *  session, loaded or not; persisted as the index */
  const index = new Map<string, number>();
  const loads = new Map<string, Promise<void>>();
  let indexLoad: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  async function readJson(path: string): Promise<unknown> {
    if (memory === undefined || !(await memory.exists(path))) return undefined;
    return JSON.parse(await memory.readFile(path)) as unknown;
  }

  async function readIndex(): Promise<void> {
    try {
      const doc = (await readJson(INDEX_PATH)) as { schemaVersion?: unknown; sessions?: unknown } | undefined;
      if (doc === undefined) return;
      if (doc.schemaVersion !== SCHEMA_VERSION || !Array.isArray(doc.sessions)) throw new Error('unsupported index');
      const fromFile = new Map<string, number>();
      for (const entry of doc.sessions) {
        if (!Array.isArray(entry)) continue;
        const [key, count] = entry as unknown[];
        if (typeof key === 'string' && typeof count === 'number') touch(fromFile, key, count);
      }
      // a session set before the index loaded is newer than the file's order
      for (const [key, count] of index) touch(fromFile, key, count);
      index.clear();
      for (const [key, count] of fromFile) index.set(key, count);
    } catch (err) {
      log(`[canvas-refresh] recipe index unreadable — starting empty: ${messageOf(err)}`);
    }
  }

  async function readSession(key: string): Promise<void> {
    try {
      const doc = (await readJson(sessionPath(key))) as { schemaVersion?: unknown; recipes?: unknown } | undefined;
      if (doc === undefined) return;
      if (doc.schemaVersion !== SCHEMA_VERSION || !Array.isArray(doc.recipes)) throw new Error('unsupported file');
      const loaded = new Map<string, RefreshSource>();
      for (const raw of doc.recipes.slice(-maxPerSession)) {
        const r = raw as { containerId?: unknown; source?: unknown };
        const source = parseRefreshSource(r?.source);
        if (typeof r?.containerId === 'string' && source) loaded.set(r.containerId, source);
      }
      // a recipe set while the file was loading is newer — it wins
      const current = sessions.get(key);
      for (const [cid, src] of current ?? []) touch(loaded, cid, src);
      if (loaded.size > 0) sessions.set(key, loaded);
      log(`[canvas-refresh] recipes loaded for canvas session: ${loaded.size}`);
    } catch (err) {
      log(`[canvas-refresh] recipes of a canvas session unreadable — starting empty: ${messageOf(err)}`);
    }
  }

  function enqueue(job: (m: RecipeMemory) => Promise<void>): void {
    if (memory === undefined) return;
    writes = writes.then(() => job(memory)).catch((err: unknown) => {
      log(`[canvas-refresh] recipe write failed: ${messageOf(err)}`);
    });
  }

  function indexDoc(): string {
    return JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessions: [...index.entries()] });
  }

  /** Drop least-recently-used sessions until the global bound holds. */
  function evict(keep: string): string[] {
    let total = [...index.values()].reduce((a, b) => a + b, 0);
    const evicted: string[] = [];
    for (const [key, count] of index) {
      if (total <= maxEntries) break;
      if (key === keep) continue;
      index.delete(key);
      sessions.delete(key);
      loads.delete(key);
      evicted.push(key);
      total -= count;
    }
    return evicted;
  }

  return {
    load(canvasSessionId) {
      if (memory === undefined) return Promise.resolve();
      const key = sessionKey(canvasSessionId);
      let pending = loads.get(key);
      if (pending === undefined) {
        indexLoad ??= readIndex();
        // a session the index does not know (never stored, or evicted) has
        // no file worth reading
        pending = indexLoad.then(() => (index.has(key) ? readSession(key) : undefined));
        loads.set(key, pending);
      }
      return pending;
    },

    get(canvasSessionId, containerId) {
      return sessions.get(sessionKey(canvasSessionId))?.get(containerId);
    },

    set(canvasSessionId, containerId, source) {
      const key = sessionKey(canvasSessionId);
      const containers = sessions.get(key) ?? new Map<string, RefreshSource>();
      touch(containers, containerId, source);
      while (containers.size > maxPerSession) {
        const oldest = containers.keys().next().value;
        if (oldest === undefined) break;
        containers.delete(oldest);
      }
      if (memory !== undefined) indexLoad ??= readIndex();
      touch(sessions, key, containers);
      touch(index, key, containers.size);
      const evicted = evict(key);
      const content = JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        recipes: [...containers].map(([cid, src]) => ({ containerId: cid, source: src })),
      });
      enqueue(async (m) => {
        // the index must not drop sessions it has not read yet: written from
        // the state after the (merged) index load
        await indexLoad;
        await m.writeFile(sessionPath(key), content);
        for (const gone of evicted) await m.delete(sessionPath(gone)).catch(() => undefined);
        await m.writeFile(INDEX_PATH, indexDoc());
      });
    },

    flush() {
      return writes;
    },
  };
}
