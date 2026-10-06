import { createHash } from 'node:crypto';

import { canonicalOwners, type MemoryStore } from '@omadia/plugin-api';

import { membersIndexRoot } from './registry/scopedMemoryStore.js';

/**
 * Owner sets of `members` context memory (W3).
 *
 * A note written in a chat belongs to the people present, exactly like a turn
 * in the graph (`TurnIngest.owners`). Each distinct owner set gets one tier,
 * keyed by a digest of its canonical member list; the list itself is recorded
 * in an index the model cannot reach, so the binder can answer "which tiers
 * does everyone here own?" without trusting anything the model wrote.
 */

/** Model-facing first segment of a read-only tier, e.g. `~g-<key>`. */
export const MEMBERS_SHARED_SEGMENT_PREFIX = '~g-';

/** The tier key of an owner set: order- and duplicate-insensitive. */
export function membersTierKey(owners: readonly string[]): string {
  return createHash('sha256')
    .update(canonicalOwners(owners).join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export interface MembersIndexEntry {
  readonly key: string;
  readonly owners: readonly string[];
}

/** How long a loaded index is trusted before it is read again. */
const INDEX_TTL_MS = 30_000;

/**
 * The per-agent index of owner sets, on the UNDECORATED root store. Cached for
 * a short TTL: a tier another process registered becomes visible within it,
 * and the tier this process registers is visible at once.
 */
export class MembersIndex {
  private cache: { loadedAt: number; entries: Map<string, MembersIndexEntry> } | undefined;

  constructor(
    private readonly root: MemoryStore,
    private readonly agentSlug: string,
  ) {}

  /** Record `owners` (idempotent) and return its tier key. */
  async register(owners: readonly string[]): Promise<string> {
    const canonical = canonicalOwners(owners);
    const key = membersTierKey(canonical);
    const entries = await this.entries();
    const path = `${membersIndexRoot(this.agentSlug)}/${key}.json`;
    // Checked even when cached: a purge may have removed the entry since.
    if (!(await this.root.fileExists(path))) {
      await this.root.createFile(path, JSON.stringify({ owners: canonical }, null, 2));
    }
    entries.set(key, { key, owners: canonical });
    return key;
  }

  /** Every recorded owner set that includes all of `audience`. */
  async coveringAudience(audience: readonly string[]): Promise<MembersIndexEntry[]> {
    const wanted = canonicalOwners(audience);
    const out: MembersIndexEntry[] = [];
    for (const entry of (await this.entries()).values()) {
      const owners = new Set(entry.owners);
      if (wanted.every((id) => owners.has(id))) out.push(entry);
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  private async entries(): Promise<Map<string, MembersIndexEntry>> {
    const now = Date.now();
    if (this.cache && now - this.cache.loadedAt < INDEX_TTL_MS) return this.cache.entries;
    const entries = new Map<string, MembersIndexEntry>();
    const dir = membersIndexRoot(this.agentSlug);
    if (await this.root.directoryExists(dir)) {
      for (const file of await this.root.list(dir)) {
        const match = /\/([a-f0-9]{32})\.json$/.exec(file.virtualPath);
        if (file.isDirectory || !match) continue;
        const entry = await this.readEntry(match[1]!, file.virtualPath);
        if (entry) entries.set(entry.key, entry);
      }
    }
    this.cache = { loadedAt: now, entries };
    return entries;
  }

  /**
   * One index file, or undefined when it is unreadable or does not hash to its
   * own name — a tier whose recorded owners do not produce its key is ignored
   * rather than trusted.
   */
  private async readEntry(key: string, path: string): Promise<MembersIndexEntry | undefined> {
    try {
      const parsed = JSON.parse(await this.root.readFile(path)) as { owners?: unknown };
      const owners = Array.isArray(parsed.owners)
        ? parsed.owners.filter((o): o is string => typeof o === 'string')
        : [];
      if (owners.length === 0 || membersTierKey(owners) !== key) return undefined;
      return { key, owners: canonicalOwners(owners) };
    } catch (err) {
      console.warn(
        `[memory] members index ${path} unreadable — tier ignored: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }
}
