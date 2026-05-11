import type {
  PreviewActivateOptions,
  PreviewHandle,
} from './previewRuntime.js';

/**
 * PreviewCache — per-user LRU of warm `PreviewHandle`s.
 *
 * Wraps the PreviewRuntime with an access-aware cache: each user has up
 * to `warmSlots` (default 3) active previews. On cap-overflow, the
 * oldest-touched preview for that user is closed (handle + filesystem
 * cleanup). Switching back to a warm draft is sub-100ms; switching to a
 * cold draft triggers `build()` + activate() through the cache miss path.
 *
 * The build pipeline (CodegenEngine + BuildQueue + BuildSandbox) is
 * deliberately not coupled here — the caller supplies a `build()` callback
 * that returns whatever ZIP + setup-field-values the activation needs. That
 * keeps the cache reusable and the test surface tight.
 *
 * `invalidate()` marks an entry stale without immediately closing it; the
 * next `get()` or `ensureWarm()` rebuilds. Closing the stale handle is the
 * cache's responsibility (in `ensureWarm`'s rebuild path) so external
 * callers don't have to track cleanup manually.
 */

export interface PreviewBuildResult {
  zipBuffer: Buffer;
  rev: number;
  /** Non-secret setup-field values from the draft. */
  configValues: Readonly<Record<string, unknown>>;
  /** Secret setup-field values (in-memory only, never persisted). */
  secretValues: Readonly<Record<string, string>>;
}

export interface EnsureWarmOptions {
  userEmail: string;
  draftId: string;
  /** Cache-miss callback. Resolved zip + setup values feed straight into
   *  PreviewRuntime.activate. */
  build: () => Promise<PreviewBuildResult>;
}

export interface PreviewCacheDeps {
  warmSlots?: number;
  /** Bound activate function — usually `runtime.activate.bind(runtime)`. */
  activate: (opts: PreviewActivateOptions) => Promise<PreviewHandle>;
  logger?: (...args: unknown[]) => void;
}

interface CacheEntry {
  userEmail: string;
  draftId: string;
  handle: PreviewHandle;
  lastAccessAt: number;
  invalidated: boolean;
}

const DEFAULT_WARM_SLOTS = 3;

function makeKey(userEmail: string, draftId: string): string {
  return `${userEmail}::${draftId}`;
}

export class PreviewCache {
  private readonly warmSlots: number;
  private readonly activateFn: PreviewCacheDeps['activate'];
  private readonly log: (...args: unknown[]) => void;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly perUser = new Map<string, Set<string>>();

  constructor(deps: PreviewCacheDeps) {
    this.warmSlots = deps.warmSlots ?? DEFAULT_WARM_SLOTS;
    this.activateFn = deps.activate;
    this.log = deps.logger ?? ((...args) => console.log('[preview-cache]', ...args));
  }

  /**
   * Returns the warm handle if present and not invalidated, else `null`.
   * Touches LRU order on hit.
   */
  get(userEmail: string, draftId: string): PreviewHandle | null {
    const key = makeKey(userEmail, draftId);
    const entry = this.entries.get(key);
    if (!entry || entry.invalidated) return null;
    // Touch — move to "most recently inserted" by re-inserting.
    this.entries.delete(key);
    entry.lastAccessAt = Date.now();
    this.entries.set(key, entry);
    return entry.handle;
  }

  /**
   * Returns a warm handle, building + activating one if cold. Enforces the
   * per-user cap by evicting the user's oldest entry (close + fs cleanup).
   */
  async ensureWarm(opts: EnsureWarmOptions): Promise<PreviewHandle> {
    const warm = this.get(opts.userEmail, opts.draftId);
    if (warm) return warm;

    // Cold (or invalidated): close any stale entry first, then rebuild.
    const key = makeKey(opts.userEmail, opts.draftId);
    const stale = this.entries.get(key);
    if (stale) {
      await this.closeQuietly(stale);
      this.entries.delete(key);
      this.perUser.get(opts.userEmail)?.delete(opts.draftId);
    }

    const built = await opts.build();

    // Evict before activate to keep the per-user cap stable even while we
    // wait on the new activation.
    await this.evictIfOverCap(opts.userEmail);

    const handle = await this.activateFn({
      zipBuffer: built.zipBuffer,
      draftId: opts.draftId,
      rev: built.rev,
      configValues: built.configValues,
      secretValues: built.secretValues,
    });

    const entry: CacheEntry = {
      userEmail: opts.userEmail,
      draftId: opts.draftId,
      handle,
      lastAccessAt: Date.now(),
      invalidated: false,
    };
    this.entries.set(key, entry);
    let userSet = this.perUser.get(opts.userEmail);
    if (!userSet) {
      userSet = new Set();
      this.perUser.set(opts.userEmail, userSet);
    }
    userSet.add(opts.draftId);

    return handle;
  }

  /**
   * Mark an entry as stale without closing. Next access triggers rebuild.
   * Called by the auto-rebuild bridge when spec/slot patches arrive.
   */
  invalidate(userEmail: string, draftId: string): void {
    const entry = this.entries.get(makeKey(userEmail, draftId));
    if (entry) entry.invalidated = true;
  }

  /** Force-evict + close one entry. Returns true if something was removed. */
  async evict(userEmail: string, draftId: string): Promise<boolean> {
    const key = makeKey(userEmail, draftId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.perUser.get(userEmail)?.delete(draftId);
    await this.closeQuietly(entry);
    return true;
  }

  /** Close + drop every preview for a user. Used at logout/session-end. */
  async dropAll(userEmail: string): Promise<void> {
    const drafts = Array.from(this.perUser.get(userEmail) ?? []);
    await Promise.allSettled(
      drafts.map((draftId) => this.evict(userEmail, draftId)),
    );
    this.perUser.delete(userEmail);
  }

  /** Close every cached handle and clear all state. SIGTERM/drain hook. */
  async closeAll(): Promise<void> {
    const all = Array.from(this.entries.values());
    this.entries.clear();
    this.perUser.clear();
    await Promise.allSettled(all.map((e) => this.closeQuietly(e)));
  }

  private async evictIfOverCap(userEmail: string): Promise<void> {
    const userSet = this.perUser.get(userEmail);
    if (!userSet || userSet.size < this.warmSlots) return;

    // Find oldest by lastAccessAt among this user's entries.
    let oldest: CacheEntry | null = null;
    for (const draftId of userSet) {
      const entry = this.entries.get(makeKey(userEmail, draftId));
      if (!entry) continue;
      if (!oldest || entry.lastAccessAt < oldest.lastAccessAt) {
        oldest = entry;
      }
    }
    if (oldest) {
      await this.evict(oldest.userEmail, oldest.draftId);
    }
  }

  private async closeQuietly(entry: CacheEntry): Promise<void> {
    try {
      await entry.handle.close();
    } catch (err) {
      this.log(
        `close failed for ${entry.userEmail}/${entry.draftId}: ${(err as Error).message}`,
      );
    }
  }

  // --- introspection (tests + diagnostics) ------------------------------

  get size(): number {
    return this.entries.size;
  }

  sizeForUser(userEmail: string): number {
    return this.perUser.get(userEmail)?.size ?? 0;
  }
}
