// Per-channel people-directory providers. One provider per channelType, in
// the ConversationRosterRegistry mould (same reason: the ServiceRegistry is
// keyed by capability name, a second channel would silently replace the first;
// this map keeps one contribution per channel type and knows its owner).
//
// Partiality is preserved on purpose: Conductor human steps route a reminder
// to whoever `principal.ref` names, so "we could not read the directory" must
// never collapse into "nobody by that name" — the operator would type an
// address the system actually knew.

import { canonicalizePrincipalRef } from '@omadia/channel-sdk';
import type { PeopleDirectoryEntry, PeopleDirectoryLookup, PeopleDirectoryProvider } from '@omadia/channel-sdk';

/** A directory hit annotated with the channel it came from. */
export interface PeopleSearchHit extends PeopleDirectoryEntry {
  readonly channelType: string;
}

export interface PeopleSearchResult {
  readonly people: readonly PeopleSearchHit[];
  /** True iff at least one queried provider failed or answered partially. */
  readonly partial: boolean;
  /** Per-provider outcome, for operator diagnostics (never an HTTP body). */
  readonly sources: readonly { readonly channelType: string; readonly lookup: PeopleDirectoryLookup }[];
}

export interface PeopleSearchOptions {
  readonly limit: number;
  /** Restrict to one channel type; absent = union over all providers. */
  readonly channelType?: string;
}

/** Hard ceiling on what a single search may return, whatever the caller asks. */
export const PEOPLE_SEARCH_MAX_LIMIT = 25;
/** A hanging directory must become `unavailable`, not a stalled builder turn. */
export const PEOPLE_SEARCH_PROVIDER_TIMEOUT_MS = 4_000;
const MAX_DISPLAY_NAME_LENGTH = 120;

export class PeopleDirectoryRegistry {
  private readonly providers = new Map<string, PeopleDirectoryProvider>();
  /** channelType → owning channel plugin id, so deactivation drops exactly its own. */
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
    private readonly providerTimeoutMs: number = PEOPLE_SEARCH_PROVIDER_TIMEOUT_MS,
  ) {}

  register(channelId: string, provider: PeopleDirectoryProvider): void {
    // First registrant owns the channel type (rosterRegistry rule): a hijacked
    // directory would feed wrong addresses into approval/escalation steps.
    const owner = this.owners.get(provider.channelType);
    if (owner !== undefined && owner !== channelId) {
      throw new Error(
        `people directory for '${provider.channelType}' already owned by channel '${owner}' (attempted: '${channelId}')`,
      );
    }
    const replaced = this.providers.has(provider.channelType);
    this.providers.set(provider.channelType, provider);
    this.owners.set(provider.channelType, channelId);
    this.log(`peopleDirectoryRegistry: ${replaced ? 'replaced' : 'registered'} provider for ${provider.channelType}`, {
      channelType: provider.channelType,
      channelId,
    });
  }

  /** Drop every provider a channel plugin registered. Idempotent. */
  unregisterChannel(channelId: string): void {
    for (const [channelType, owner] of this.owners) {
      if (owner !== channelId) continue;
      this.providers.delete(channelType);
      this.owners.delete(channelType);
      this.log(`peopleDirectoryRegistry: unregistered ${channelType} (channel ${channelId} deactivated)`);
    }
  }

  types(): readonly string[] {
    return Array.from(this.providers.keys()).sort();
  }

  /**
   * Union search across the selected providers. A throwing or `unavailable`
   * provider marks the result `partial` and is reported in `sources`; it never
   * fails the search. Entries are de-duplicated on the canonical principal ref
   * and the union is capped at `limit` (≤ PEOPLE_SEARCH_MAX_LIMIT).
   */
  async search(query: string, opts: PeopleSearchOptions): Promise<PeopleSearchResult> {
    const limit = Math.max(1, Math.min(PEOPLE_SEARCH_MAX_LIMIT, Math.floor(opts.limit)));
    const selected = Array.from(this.providers.values()).filter(
      (p) => opts.channelType === undefined || p.channelType === opts.channelType,
    );
    const sources: { channelType: string; lookup: PeopleDirectoryLookup }[] = [];
    const seen = new Set<string>();
    const people: PeopleSearchHit[] = [];
    let partial = false;

    for (const provider of selected) {
      const lookup = await this.lookup(provider, query, limit);
      sources.push({ channelType: provider.channelType, lookup });
      if (lookup.outcome === 'unavailable') {
        partial = true;
        continue;
      }
      if (lookup.partial) partial = true;
      // The same person may be routable on two channels — keep one hit per (channel, ref)
      // so the operator can pick the channel the step should use.
      for (const entry of lookup.people) {
        const hit = sanitizeEntry(entry, provider.channelType);
        const key = hit ? `${hit.channelType}\u0000${hit.principalRef}` : '';
        if (!hit || seen.has(key)) continue;
        seen.add(key);
        people.push(hit);
      }
    }
    return { people: people.slice(0, limit), partial, sources };
  }

  private async lookup(provider: PeopleDirectoryProvider, query: string, limit: number): Promise<PeopleDirectoryLookup> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${String(this.providerTimeoutMs)}ms`)), this.providerTimeoutMs);
      });
      const answer: unknown = await Promise.race([provider.search(query, { limit }), deadline]);
      // A malformed answer (not an object, unknown outcome, non-array people) is a broken
      // source — reported as unavailable so it marks the result partial, never as "nobody".
      return isWellFormedLookup(answer)
        ? answer
        : { outcome: 'unavailable', code: 'source_error', message: 'provider returned a malformed lookup' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`peopleDirectoryRegistry: ${provider.channelType} search FAILED — treating as unavailable`, {
        channelType: provider.channelType,
        error: message,
      });
      return { outcome: 'unavailable', code: 'source_error', message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function isWellFormedLookup(v: unknown): v is PeopleDirectoryLookup {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  if (rec.outcome === 'unavailable') {
    return (rec.code === 'source_error' || rec.code === 'not_configured' || rec.code === 'not_supported') && typeof rec.message === 'string';
  }
  return rec.outcome === 'resolved' && Array.isArray(rec.people) && typeof rec.partial === 'boolean';
}

/**
 * Boundary guard over plugin data. A ref that is empty after canonicalization
 * or contains whitespace can never match a channel binding, so the entry is
 * dropped rather than offered as a routable person (silent-misrouting guard).
 */
function sanitizeEntry(entry: PeopleDirectoryEntry, channelType: string): PeopleSearchHit | null {
  if (typeof entry !== 'object' || entry === null) return null;
  if (typeof entry.principalRef !== 'string' || typeof entry.displayName !== 'string') return null;
  const principalRef = canonicalizePrincipalRef('user', entry.principalRef);
  if (principalRef.length === 0 || /\s/.test(principalRef)) return null;
  const displayName = entry.displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (displayName.length === 0) return null;
  return {
    channelType,
    principalRef,
    displayName,
    ...(typeof entry.email === 'string' && entry.email.trim() ? { email: entry.email.trim().toLowerCase() } : {}),
    ...(typeof entry.channelUserId === 'string' && entry.channelUserId ? { channelUserId: entry.channelUserId } : {}),
    ...(typeof entry.hint === 'string' && entry.hint ? { hint: entry.hint.slice(0, MAX_DISPLAY_NAME_LENGTH) } : {}),
  };
}
