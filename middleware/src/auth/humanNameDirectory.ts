/**
 * #2042 — the names of the humans of this install, for the privacy shield's
 * own-name exemption (`agentOwnNames`, docs/security-architecture.md §6f).
 *
 * An agent's own name is never masked in its own turn — unless a real person
 * bears it. The people are the ACTIVE rows of the `users` table; each counts
 * with its display name, its first name and its last name (first and last
 * word of the display name — the table has no separate columns), so an agent
 * "Karen" stays masked once "Karen Müller" is a user.
 *
 * The orchestrator reads the names synchronously, once per turn, so this
 * directory serves a snapshot: loaded asynchronously at start, reloaded after
 * every user change (`invalidate`, wired to `UserStore.onChange`) and after a
 * TTL as a safety net. Until a load has succeeded — and after a failed one —
 * the snapshot is UNKNOWN (`null`): the turn then exempts no own name at all,
 * masking wins. The names are never logged.
 */

/** Safety-net reload interval, on top of the invalidation from user writes. */
export const HUMAN_NAMES_TTL_MS = 5 * 60 * 1000;

/** The human names an agent's own name is compared against (#2042). */
export function humanNamesOf(displayName: string): readonly string[] {
  const full = displayName.trim().replace(/\s+/g, ' ');
  if (full.length === 0) return [];
  const words = full.split(' ');
  const first = words[0] ?? '';
  const last = words[words.length - 1] ?? '';
  return [...new Set([full, first, last])];
}

export interface HumanNameDirectoryOptions {
  /** Display names of the active users (`UserStore.listActiveDisplayNames`). */
  readonly loadDisplayNames: () => Promise<readonly string[]>;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Operational log; never receives a name. */
  readonly log?: (message: string) => void;
}

export class HumanNameDirectory {
  private names: readonly string[] | null = null;
  private loadedAt = 0;
  /** Bumped by every invalidation; a load that started earlier is followed by another. */
  private version = 0;
  private inFlight: Promise<void> | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: HumanNameDirectoryOptions) {
    this.ttlMs = options.ttlMs ?? HUMAN_NAMES_TTL_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * The current snapshot, synchronously. `null` = unknown (no successful load
   * yet, or the last one failed): the caller must exempt no own name. A stale
   * or unknown snapshot starts a background reload; this call never waits.
   */
  snapshot(): readonly string[] | null {
    if (this.names === null || this.now() - this.loadedAt >= this.ttlMs) {
      void this.refresh();
    }
    return this.names;
  }

  /** A user changed: reload now. Until it lands the last snapshot is served. */
  invalidate(): void {
    this.version += 1;
    void this.refresh();
  }

  /**
   * Load the names. Concurrent calls share one load; an invalidation that
   * arrives during a load triggers another one once it finished.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const startVersion = this.version;
    const load = this.load().finally(() => {
      this.inFlight = undefined;
      if (this.version !== startVersion) void this.refresh();
    });
    this.inFlight = load;
    return load;
  }

  private async load(): Promise<void> {
    try {
      const displayNames = await this.options.loadDisplayNames();
      this.names = [...new Set(displayNames.flatMap(humanNamesOf))];
      this.loadedAt = this.now();
    } catch (err) {
      // Fail safe: an unknown directory exempts no own name. Message only —
      // never the names, never row data.
      this.names = null;
      this.log(
        `[humanNames] loading the active users' names failed, no own-name exemption until the next load: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** The part of `UserStore` the directory reads and listens to. */
export interface HumanNameSource {
  listActiveDisplayNames(): Promise<readonly string[]>;
  onChange(listener: () => void): () => void;
}

/**
 * The directory over the users table: invalidated by every user write of
 * this process, first load started right away (not awaited — until it lands
 * the snapshot is unknown and masking wins).
 */
export function createUserHumanNameDirectory(
  users: HumanNameSource,
  options: Omit<HumanNameDirectoryOptions, 'loadDisplayNames'> = {},
): HumanNameDirectory {
  const directory = new HumanNameDirectory({
    ...options,
    loadDisplayNames: () => users.listActiveDisplayNames(),
  });
  users.onChange(() => directory.invalidate());
  void directory.refresh();
  return directory;
}
