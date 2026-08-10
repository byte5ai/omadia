/**
 * Idempotency for write-capable tool dispatch (#542 prerequisite).
 *
 * ## The problem
 *
 * Two independent retry layers can each execute one logical tool call twice:
 *
 *   1. **Transport retry** — `McpManager.callTool` retries ONCE on a transient
 *      transport failure (a deliberate, shipped mitigation for a flaky hosted
 *      proxy). A timeout or dropped connection is indistinguishable from "the
 *      server executed the write and the response was lost", so attempt 2 can
 *      re-execute a mutation that already happened.
 *   2. **Caller retry** — an MCP client (or any HTTP caller of a future public
 *      endpoint) re-sends `tools/call` after a timeout. The dispatch layer sees
 *      two separate dispatches.
 *
 * For a read tool both are harmless. For a write tool (`Odoo`, `M365`) a
 * duplicate is customer-data damage, which is why this exists before write tools
 * are exposed publicly.
 *
 * ## What this module provides
 *
 * - {@link ToolIdempotencyStore} — a process-local dedupe cache that collapses
 *   layer 2: the first dispatch under a given key executes, later dispatches
 *   under the SAME key replay the first result without re-executing.
 * - {@link runWithIdempotencyScope} / {@link currentIdempotencyScope} — an
 *   `AsyncLocalStorage` channel that carries the active key DOWN to layer 1
 *   without touching `NativeToolHandler`. That contract
 *   (`(input: unknown) => Promise<string>`) is published and implemented by
 *   out-of-tree plugins, so threading a key through it as a parameter is not an
 *   option; ambient propagation is the same trick the privacy handle already
 *   uses via `turnContext`.
 *
 * ## What the guarantee actually is — and is NOT
 *
 * GUARANTEED, within one process:
 *   - Two dispatches with the same `(idempotencyKey, toolName)` execute the
 *     underlying handler at most once while the first entry is live (bounded by
 *     {@link DEFAULT_IDEMPOTENCY_TTL_MS} and {@link DEFAULT_IDEMPOTENCY_MAX_ENTRIES}).
 *   - Concurrent duplicates collapse onto one in-flight execution rather than
 *     racing.
 *   - A replay carrying a DIFFERENT payload under an already-used key is
 *     rejected as a conflict instead of executing (see {@link idempotencyConflictMessage}).
 *
 * NOT GUARANTEED — do not read this as distributed idempotency:
 *   - **Process-local only.** The cache is an in-memory `Map`. Two middleware
 *     instances behind a load balancer, or a restart between the original call
 *     and the retry, will BOTH execute. Making this distributed requires a
 *     shared store (Postgres/Redis) keyed the same way; the key composition here
 *     is deliberately serialisable so that swap is additive.
 *   - **Bounded, not permanent.** After TTL expiry or LRU eviction a replayed
 *     key executes again.
 *   - **Failures are not cached.** See {@link ToolIdempotencyStore.run} — an
 *     errored call leaves no entry, so a caller retry re-executes it. This is a
 *     deliberate trade (a cached failure would make a legitimate retry
 *     impossible) and it means "exactly once" holds for SUCCEEDING calls; for a
 *     call that failed mid-flight the protection that applies is the layer-1
 *     retry suppression in `McpManager.callTool`, not this cache.
 *   - **No remote enforcement.** The key is advertised to MCP servers in
 *     `_meta.idempotencyKey` so a server that implements dedupe can use it, but
 *     MCP defines no standard idempotency field and no server is required to
 *     honour it. Never treat propagation as protection.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/** How long a completed idempotency record stays replayable. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

/** Hard cap on retained records; oldest-inserted is evicted first. */
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 1000;

/**
 * The active idempotency scope, readable by any layer below the dispatcher.
 *
 * `exactlyOnce` is the ONLY signal `McpManager.callTool` uses to suppress its
 * transient retry. It is set by the dispatcher exclusively for write-capable
 * tools, so read tools keep the flaky-proxy retry mitigation unchanged.
 */
export interface ToolIdempotencyScope {
  readonly key: string;
  readonly toolName: string;
  /**
   * `true` ⇒ the caller asked for at-most-once execution of a WRITE-capable
   * tool. Layers that cannot distinguish "failed before executing" from "failed
   * after executing" must not retry under this flag.
   */
  readonly exactlyOnce: boolean;
}

const scopeStorage = new AsyncLocalStorage<ToolIdempotencyScope>();

/** The idempotency scope of the in-flight dispatch, if any. */
export function currentIdempotencyScope(): ToolIdempotencyScope | undefined {
  return scopeStorage.getStore();
}

/** Run `fn` with `scope` visible to every layer beneath it. */
export function runWithIdempotencyScope<T>(
  scope: ToolIdempotencyScope,
  fn: () => T,
): T {
  return scopeStorage.run(scope, fn);
}

/** The stored outcome of a deduplicated dispatch. */
export interface ToolIdempotencyResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** Outcome of a {@link ToolIdempotencyStore.run} call. */
export interface ToolIdempotencyOutcome {
  readonly result: ToolIdempotencyResult;
  /** `true` when `result` came from the cache and the executor never ran. */
  readonly replayed: boolean;
}

interface StoredEntry {
  readonly fingerprint: string;
  readonly storedAt: number;
  readonly inFlight?: Promise<ToolIdempotencyResult>;
  readonly result?: ToolIdempotencyResult;
}

/** Stable JSON: object keys sorted at every depth so `{a,b}` and `{b,a}` hash equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Payload fingerprint used to detect same-key-different-body conflicts. */
export function fingerprintToolInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

/**
 * Cache key for a `(namespace, key, toolName)` triple.
 *
 * `namespace` is the TRUST BOUNDARY, and it is required rather than defaulted
 * because omitting it is not a smaller version of this feature — it is a
 * cross-tenant leak. The store is process-wide and shared by every public MCP
 * dispatcher. Keyed on tool name and the caller-supplied key alone, API key A
 * calling `create_invoice` with `invoice-42` and API key B — a different
 * customer, bound to a different agent — using the same obvious string collide:
 * B receives A's cached RESULT and B's write never executes. It also hands any
 * key holder a denial primitive, since idempotency keys are guessable and
 * pre-claiming one suppresses the real caller's write.
 *
 * "Same key and same tool ⇒ deduping is the right answer" holds for one tenant.
 * Across principals it is exactly the wrong answer.
 *
 * Length-prefixed on each component so they cannot be confused by a
 * caller-supplied key containing the separator — `("a:b", "t")` and
 * `("b", "t:a")` must not collide. Plain ASCII and deliberately serialisable, so
 * a future distributed store can reuse this exact composition.
 */
export function idempotencyCacheKey(
  key: string,
  toolName: string,
  namespace: string,
): string {
  return `${String(namespace.length)}:${namespace}:${String(toolName.length)}:${toolName}:${key}`;
}

/**
 * The error a caller gets when it reuses a key with a different payload. Echoing
 * the tool name (not the payload) keeps the message safe to surface.
 */
export function idempotencyConflictMessage(toolName: string): string {
  return `Error: idempotency key reused for tool \`${toolName}\` with a different payload — refusing to execute. Use a fresh key for a different request.`;
}

/**
 * Process-local dedupe cache for write-capable tool dispatch.
 *
 * See the module header for the precise scope of the guarantee. In particular
 * this is NOT distributed idempotency.
 */
export class ToolIdempotencyStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options?: {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    /** Injectable clock — TTL expiry is tested without real waiting. */
    readonly now?: () => number;
  }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Execute `exec` at most once per `(namespace, key, toolName)` while the entry
   * is live.
   *
   * - Live completed entry, same payload ⇒ replay it, `exec` is NOT called.
   * - Live entry, DIFFERENT payload ⇒ conflict error, `exec` is NOT called.
   * - Live in-flight entry, same payload ⇒ await the original execution.
   * - No live entry ⇒ run `exec` and store the result.
   *
   * A rejected or `isError` outcome is NOT retained (see module header).
   *
   * `namespace` scopes the guarantee to one principal — see
   * {@link idempotencyCacheKey} for why it is required and not defaulted.
   */
  async run(
    key: string,
    toolName: string,
    input: unknown,
    exec: () => Promise<ToolIdempotencyResult>,
    namespace: string,
  ): Promise<ToolIdempotencyOutcome> {
    const cacheKey = idempotencyCacheKey(key, toolName, namespace);
    const fingerprint = fingerprintToolInput(input);
    const existing = this.live(cacheKey);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return {
          result: { content: idempotencyConflictMessage(toolName), isError: true },
          replayed: true,
        };
      }
      if (existing.result !== undefined) {
        return { result: existing.result, replayed: true };
      }
      if (existing.inFlight !== undefined) {
        // Collapse a concurrent duplicate onto the original execution. If the
        // original rejects, this duplicate must surface that rejection too —
        // it never got its own execution.
        return { result: await existing.inFlight, replayed: true };
      }
    }

    const inFlight = exec();
    this.entries.set(cacheKey, { fingerprint, storedAt: this.now(), inFlight });
    // Bound the map on the IN-FLIGHT path too. Eviction used to run only after a
    // successful completion, so a burst of dispatches that were all still
    // running (or a handler that never settles) grew the map past `maxEntries`
    // with nothing ever calling the evictor.
    this.evictOverflow();
    // A duplicate awaiting `inFlight` handles its own rejection; this guard only
    // stops an unobserved rejection from killing the process.
    inFlight.catch(() => undefined);

    // Every write below is conditional on OUR entry still being the one in the
    // map. Once an in-flight entry can expire or be evicted (see `live`), a
    // later dispatch may legitimately have installed its own execution under
    // this key while this one was still running; a blind `set`/`delete` here
    // would clobber that newer entry with this older execution's outcome.
    const stillOurs = (): boolean => this.entries.get(cacheKey)?.inFlight === inFlight;

    let result: ToolIdempotencyResult;
    try {
      result = await inFlight;
    } catch (error) {
      // Not retained — a caller retry after a thrown failure is allowed to run.
      if (stillOurs()) this.entries.delete(cacheKey);
      throw error;
    }
    if (result.isError === true) {
      if (stillOurs()) this.entries.delete(cacheKey);
      return { result, replayed: false };
    }
    if (stillOurs()) {
      this.entries.set(cacheKey, { fingerprint, storedAt: this.now(), result });
      this.evictOverflow();
    }
    return { result, replayed: false };
  }

  /**
   * `true` for an entry whose execution is still running AND still within the
   * window in which it is worth collapsing duplicates onto.
   *
   * An in-flight entry used to be exempt from expiry AND from eviction with no
   * upper bound at all, on the reasoning that it "never expires out from under
   * its own execution". That reasoning holds only while the execution actually
   * finishes: a handler that hangs forever (the exact failure the dispatch
   * deadline exists for — and the deadline resolves the SLOT, it does not make
   * this promise settle) pinned its key permanently, made every later call under
   * that key wait on a promise that never resolves, and made the entry
   * un-evictable, so the map grew past `maxEntries` unchecked. Past the TTL an
   * in-flight entry is therefore treated exactly like a stale completed one.
   */
  private isLiveInFlight(entry: StoredEntry): boolean {
    if (entry.inFlight === undefined || entry.result !== undefined) return false;
    return this.now() - entry.storedAt < this.ttlMs;
  }

  /** Entry for `cacheKey` if it exists and has not expired; prunes on expiry. */
  private live(cacheKey: string): StoredEntry | undefined {
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) return undefined;
    // A still-running execution inside its TTL: collapse duplicates onto it.
    if (this.isLiveInFlight(entry)) return entry;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      // Also covers an in-flight entry past its TTL. Deleting the map entry does
      // NOT cancel the underlying execution (nothing here can) — it stops a
      // hung one from blocking every future call under this key, which is the
      // difference between a stuck tool and a stuck key.
      this.entries.delete(cacheKey);
      return undefined;
    }
    return entry;
  }

  /** Insertion-order eviction. Never drops an execution that is still live —
   *  but an in-flight entry past its TTL is no longer live (see
   *  {@link isLiveInFlight}) and is evictable like any other stale row. */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      let evicted = false;
      for (const [k, v] of this.entries) {
        if (this.isLiveInFlight(v)) continue;
        this.entries.delete(k);
        evicted = true;
        break;
      }
      if (!evicted) return;
    }
  }

  /** Retained record count — test/observability aid. */
  size(): number {
    return this.entries.size;
  }
}
