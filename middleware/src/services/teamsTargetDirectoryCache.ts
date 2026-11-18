// #2043 rollout (D8) — the team/chat picker that never finished loading.
//
// `GET /:slug/teams/targets` listed every team and every chat through the
// connector on EVERY request. In a tenant with 725 chats that is twenty Graph
// pages with members expanded: longer than the browser waits, so the picker
// showed "loading …" for the whole session, and every reload started the same
// enumeration again.
//
// What stands in front of the directory now:
//
//   * the TEAM list and the CHAT list are loaded and kept independently: the
//     team list is short and app-only, the chat list is the slow one;
//   * the chats are enumerated ONLY when asked for (a search, or an explicit
//     full list). Opening the picker asks for teams and for the chats the
//     instance's bots are already in (`teamsRecentTargets.ts`), nothing more;
//   * ONE enumeration per half at a time, shared by every caller, its result
//     kept for fifteen minutes;
//   * a BOUNDED WAIT: a caller gets the result if it arrives within
//     `waitMs`, otherwise the half answers `loading` at once while the
//     enumeration goes on, and the next call picks it up;
//   * SEARCH AND A SIZE LIMIT on the server: `q` filters by name, topic and
//     member names, `limit` caps what is sent, and each half says how many
//     there are in total, so a truncated list is never mistaken for all of it.
//
// A failed half is not kept: the next call looks again. The cache is ONE
// object per router (see `createTeamsTargetDirectoryCache`).

import type { TeamsChatSummary, TeamsTeamSummary } from '../platform/teamsTargetDirectory.js';

import type {
  TeamsTargetDirectory,
  TeamsTargetListingUnavailable,
} from './teamsTargetDirectoryService.js';

export const TEAMS_TARGETS_DEFAULT_LIMIT = 1000;
export const TEAMS_TARGETS_MAX_LIMIT = 2000;
// A chat enumeration costs a minute of Graph paging in a large tenant.
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_WAIT_MS = 8_000;

/** One half as the route answers it. */
export type TeamsTargetPage<T> =
  | {
      readonly available: true;
      readonly items: readonly T[];
      /** How many the tenant has (before `q` and `limit`). */
      readonly total: number;
      /** How many match `q` (equals `total` without one). */
      readonly matched: number;
      /**
       * The list is not everything there is: `items` is shorter than
       * `matched` (this route's `limit`), or the connector itself stopped
       * before Graph's last page ({@link sourceTruncated}).
       */
      readonly truncated: boolean;
      /** The connector's own list is incomplete (connector >= 0.9.1 reports
       *  it). Then `total` is a lower bound, and a search cannot find what
       *  was never listed. */
      readonly sourceTruncated: boolean;
      /** Chats: untitled chats that came back without member names. */
      readonly withoutMemberNames?: number;
      /**
       * Chats: whose members a search can match. `untitled_only` since
       * connector 0.9.1: a chat WITH a topic carries no member names, so it
       * is found by its topic or id only. `all` when titled chats carry them
       * (0.9.0 and older), `none` when no chat does.
       */
      readonly memberSearch?: 'all' | 'untitled_only' | 'none';
    }
  | {
      readonly available: false;
      /** `loading`: the enumeration is still running; ask again shortly.
       *  `not_requested`: this half was not asked for (see `chats`). */
      readonly reason: TeamsTargetListingUnavailable | 'loading' | 'not_requested';
    };

export interface TeamsTargetDirectoryPage {
  readonly teams: TeamsTargetPage<TeamsTeamSummary>;
  readonly chats: TeamsTargetPage<TeamsChatSummary>;
}

export interface TeamsTargetQuery {
  readonly q?: string;
  readonly limit?: number;
  /** Ignore a kept result and enumerate again. */
  readonly refresh?: boolean;
  /**
   * Whether the CHATS of the tenant are wanted at all. `false`: the chat
   * half answers `not_requested` and nothing is enumerated for it. A picker
   * does not need every chat of a tenant to pick one target (#2043 D8: 4,560
   * chats took a minute per opening), so the route asks for them only for a
   * search or on explicit request. Default `true`.
   */
  readonly chats?: boolean;
}

export interface TeamsTargetDirectoryCacheOptions {
  /** The two halves, loaded and kept independently: the team list is short
   *  and app-only, the chat list is the slow one. */
  readonly loadTeams: () => Promise<TeamsTargetDirectory['teams']>;
  readonly loadChats: () => Promise<TeamsTargetDirectory['chats']>;
  readonly ttlMs?: number;
  readonly waitMs?: number;
  readonly now?: () => number;
  /** Resolves after `ms`; injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (msg: string) => void;
}

const fold = (value: string): string => value.normalize('NFKD').toLowerCase();

function page<T>(
  listing: TeamsTargetDirectory['teams'] | TeamsTargetDirectory['chats'],
  haystackOf: (item: T) => readonly (string | null | undefined)[],
  query: TeamsTargetQuery,
): TeamsTargetPage<T> {
  if (!listing.available) return { available: false, reason: listing.reason };
  const all = listing.items as readonly T[];
  const needle = fold((query.q ?? '').trim());
  const matches =
    needle === ''
      ? all
      : all.filter((item) =>
          haystackOf(item).some((text) => typeof text === 'string' && fold(text).includes(needle)),
        );
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? TEAMS_TARGETS_DEFAULT_LIMIT)),
    TEAMS_TARGETS_MAX_LIMIT,
  );
  const sourceTruncated = listing.sourceTruncated === true;
  return {
    available: true,
    items: matches.slice(0, limit),
    total: all.length,
    matched: matches.length,
    truncated: matches.length > limit || sourceTruncated,
    sourceTruncated,
    ...(listing.withoutMemberNames !== undefined && listing.withoutMemberNames > 0
      ? { withoutMemberNames: listing.withoutMemberNames }
      : {}),
  };
}

/** Whose member names the chats of a listing carry (see `memberSearch`). */
function memberSearchOf(chats: readonly TeamsChatSummary[]): 'all' | 'untitled_only' | 'none' {
  const named = chats.filter((chat) => (chat.memberNames?.length ?? 0) > 0);
  if (named.length === 0) return 'none';
  return named.some((chat) => chat.topic !== null) ? 'all' : 'untitled_only';
}

export function pageOfTeamsTargets(
  directory: TeamsTargetDirectory,
  query: TeamsTargetQuery = {},
): TeamsTargetDirectoryPage {
  // Member names are matched where the connector supplied them. Since
  // connector 0.9.1 that is untitled chats only; `memberSearch` says which,
  // so the picker can tell the operator instead of silently finding less.
  const chats = page<TeamsChatSummary>(
    directory.chats,
    (chat) => [chat.topic, chat.id, ...(chat.memberNames ?? [])],
    query,
  );
  return {
    teams: page<TeamsTeamSummary>(directory.teams, (team) => [team.displayName, team.id], query),
    chats:
      chats.available && directory.chats.available
        ? { ...chats, memberSearch: memberSearchOf(directory.chats.items) }
        : chats,
  };
}

export interface TeamsTargetDirectoryCache {
  get(query?: TeamsTargetQuery): Promise<TeamsTargetDirectoryPage>;
}

type Listing<T> = { readonly available: true; readonly items: readonly T[] } | { readonly available: false; readonly reason: TeamsTargetListingUnavailable };

/**
 * ONE half: a single enumeration at a time, shared by every caller, its
 * result kept for `ttlMs`. `read` resolves with the listing, or with
 * `'loading'` when the enumeration outlasts `waitMs` (it goes on, and the
 * next `read` joins it or finds its result).
 */
function createHalf<L extends Listing<unknown>>(
  name: string,
  load: () => Promise<L>,
  opts: {
    readonly ttlMs: number;
    readonly waitMs: number;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly log?: (msg: string) => void;
  },
): { read(refresh: boolean): Promise<L | 'loading' | 'failed'> } {
  let kept: { readonly at: number; readonly listing: L } | undefined;
  let inFlight: Promise<L | undefined> | undefined;
  const enumerate = (): Promise<L | undefined> => {
    inFlight ??= (async () => {
      const started = opts.now();
      try {
        const listing = await load();
        // Only a readable listing is kept; a failure is looked at again.
        if (listing.available) kept = { at: opts.now(), listing };
        opts.log?.(
          `[teams-targets] ${name} enumerated in ${String(opts.now() - started)}ms: ${
            listing.available ? String(listing.items.length) : listing.reason
          }`,
        );
        return listing;
      } catch (err) {
        opts.log?.(`[teams-targets] ${name} enumeration failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
  return {
    async read(refresh) {
      if (!refresh && kept !== undefined && opts.now() - kept.at <= opts.ttlMs) return kept.listing;
      const settled = await Promise.race([
        enumerate().then((listing) => ({ listing })),
        opts.sleep(opts.waitMs).then(() => undefined),
      ]);
      if (settled === undefined) return 'loading';
      return settled.listing ?? 'failed';
    },
  };
}

/**
 * The directory behind `GET /:slug/teams/targets`. Create ONE per router and
 * keep it: the cache is the object. (#2043 D14: the first version was looked
 * up in a WeakMap keyed by an object the route builds anew for every request,
 * so every request got an empty cache, started its own enumeration and
 * answered `loading` for ever.)
 */
export function createTeamsTargetDirectoryCache(
  opts: TeamsTargetDirectoryCacheOptions,
): TeamsTargetDirectoryCache {
  const shared = {
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    waitMs: opts.waitMs ?? DEFAULT_WAIT_MS,
    now: opts.now ?? Date.now,
    sleep:
      opts.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        })),
    ...(opts.log ? { log: opts.log } : {}),
  };
  const teams = createHalf('teams', opts.loadTeams, shared);
  const chats = createHalf('chats', opts.loadChats, shared);
  const settle = <L extends Listing<unknown>>(
    read: L | 'loading' | 'failed',
  ): L | { available: false; reason: 'loading' | 'lookup_failed' } =>
    read === 'loading'
      ? { available: false, reason: 'loading' }
      : read === 'failed'
        ? { available: false, reason: 'lookup_failed' }
        : read;

  return {
    async get(query = {}) {
      const refresh = query.refresh === true;
      const wantChats = query.chats !== false;
      const [teamHalf, chatHalf] = await Promise.all([
        teams.read(refresh),
        wantChats ? chats.read(refresh) : Promise.resolve(undefined),
      ]);
      const teamListing = settle(teamHalf);
      const chatListing = chatHalf === undefined ? undefined : settle(chatHalf);
      const pageOf = pageOfTeamsTargets(
        {
          teams: teamListing.available ? teamListing : { available: true, items: [] },
          chats: chatListing?.available ? chatListing : { available: true, items: [] },
        },
        query,
      );
      return {
        teams: teamListing.available ? pageOf.teams : { available: false, reason: teamListing.reason },
        chats:
          chatListing === undefined
            ? { available: false, reason: 'not_requested' }
            : chatListing.available
              ? pageOf.chats
              : { available: false, reason: chatListing.reason },
      };
    },
  };
}
