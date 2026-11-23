/**
 * #2042 — the names of the humans of this install, for the privacy shield's
 * own-name exemption (`agentOwnNames`, docs/security-architecture.md §6f).
 *
 * An agent's own name is never masked in its own turn — unless a real person
 * bears it. The people are the ACTIVE rows of the `users` table (owner
 * decision: a disabled user lifts the veto for that name); each counts with
 * its full display name and every word of it (`humanNamesOf` — the table has
 * no separate first/last-name columns), so an agent "Karen" stays masked once
 * "Karen Müller" or "Müller, Karen" is a user.
 *
 * The orchestrator reads the names synchronously, once per turn, so this
 * directory serves a snapshot. The kernel creates and publishes it before
 * plugin activation; the users table is attached (`attach`) once the database
 * is up, which starts the first load. It reloads after every user change
 * (`invalidate`, wired to `UserStore.onChange`) and after a TTL as a safety
 * net. Until a load has succeeded — and after a failed one — the snapshot is
 * UNKNOWN (`null`): the turn then exempts no own name at all, masking wins.
 * The names are never logged.
 */

/** Safety-net reload interval, on top of the invalidation from user writes. */
export const HUMAN_NAMES_TTL_MS = 5 * 60 * 1000;

/** Words shorter than this are no name on their own ("A.", "v"). */
const MIN_NAME_WORD_LENGTH = 2;

/** Punctuation around a word of a display name ("Müller," "(Karen)"). */
const SURROUNDING_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/**
 * The human names an agent's own name is compared against (#2042): the full
 * display name plus every word of it with surrounding punctuation stripped,
 * words under 2 characters dropped. Covers "Karen Müller", "Müller, Karen"
 * and multi-word surnames ("Anna van der Berg" → "Berg", "van", "der" too).
 */
export function humanNamesOf(displayName: string): readonly string[] {
  const full = displayName.trim().replace(/\s+/g, ' ');
  if (full.length === 0) return [];
  const words = full
    .split(' ')
    .map((w) => w.replace(SURROUNDING_PUNCTUATION, ''))
    .filter((w) => w.length >= MIN_NAME_WORD_LENGTH);
  return [...new Set([full, ...words])];
}

/** The part of `UserStore` the directory reads and listens to. */
export interface HumanNameSource {
  /** Display names of the active users (`UserStore.listActiveDisplayNames`). */
  listActiveDisplayNames(): Promise<readonly string[]>;
  onChange(listener: () => void): () => void;
}

export interface HumanNameDirectoryOptions {
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
  private source: HumanNameSource | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: HumanNameDirectoryOptions = {}) {
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

  /**
   * Attach the users table (once the database is up): every user write
   * invalidates the snapshot, and the first load starts right away (not
   * awaited — until it lands the snapshot is unknown and masking wins).
   */
  attach(source: HumanNameSource): void {
    this.source = source;
    source.onChange(() => this.invalidate());
    // Via invalidate, not refresh: a load started before the attach (a turn
    // that found no source) must be followed by a real one.
    this.invalidate();
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
    // No users table attached yet: stays unknown, nothing to report.
    if (!this.source) return;
    try {
      const displayNames = await this.source.listActiveDisplayNames();
      this.names = [...new Set(displayNames.flatMap(humanNamesOf))];
      this.loadedAt = this.now();
    } catch (err) {
      // Deliberate: a failed load drops the last snapshot instead of serving
      // it, so the directory is unknown and the turn exempts no own name —
      // masking wins over a possibly stale exemption. Message only — never
      // the names, never row data.
      this.names = null;
      this.log(
        `[humanNames] loading the active users' names failed, no own-name exemption until the next load: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** A directory already attached to `users` (tests, single-step hosts). */
export function createUserHumanNameDirectory(
  users: HumanNameSource,
  options: HumanNameDirectoryOptions = {},
): HumanNameDirectory {
  const directory = new HumanNameDirectory(options);
  directory.attach(users);
  return directory;
}
