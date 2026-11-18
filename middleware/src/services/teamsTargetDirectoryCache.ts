// #2043 rollout (D8) — the team/chat picker that never finished loading.
//
// `GET /:slug/teams/targets` listed every team and every chat through the
// connector on EVERY request. In a tenant with 725 chats that is twenty Graph
// pages with members expanded: longer than the browser waits, so the picker
// showed "loading …" for the whole session, and every reload started the same
// enumeration again.
//
// This puts three things in front of the directory:
//
//   * ONE enumeration at a time, shared by every caller, and its result kept
//     for a few minutes (a picker is opened, closed and reopened);
//   * a BOUNDED WAIT: a caller gets the result if it arrives within
//     `waitMs`, otherwise each half answers `loading` at once while the
//     enumeration goes on, and the next call (the UI asks again) picks it up;
//   * SEARCH AND A SIZE LIMIT on the server: `q` filters by name, topic and
//     member names, `limit` caps what is sent, and each half says how many
//     there are in total, so a truncated list is never mistaken for all of it.
//
// A failed half is not kept: the next call looks again.

import type { TeamsChatSummary, TeamsTeamSummary } from '../platform/teamsTargetDirectory.js';

import type {
  TeamsTargetDirectory,
  TeamsTargetListingUnavailable,
} from './teamsTargetDirectoryService.js';

export const TEAMS_TARGETS_DEFAULT_LIMIT = 1000;
export const TEAMS_TARGETS_MAX_LIMIT = 2000;
const DEFAULT_TTL_MS = 5 * 60_000;
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
      /** `loading`: the enumeration is still running; ask again shortly. */
      readonly reason: TeamsTargetListingUnavailable | 'loading';
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
}

export interface TeamsTargetDirectoryCacheOptions {
  readonly load: () => Promise<TeamsTargetDirectory>;
  readonly ttlMs?: number;
  readonly waitMs?: number;
  readonly now?: () => number;
  /** Resolves after `ms`; injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (msg: string) => void;
}

const LOADING: TeamsTargetDirectoryPage = {
  teams: { available: false, reason: 'loading' },
  chats: { available: false, reason: 'loading' },
};

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

export function createTeamsTargetDirectoryCache(
  opts: TeamsTargetDirectoryCacheOptions,
): TeamsTargetDirectoryCache {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  let kept: { readonly at: number; readonly directory: TeamsTargetDirectory } | undefined;
  let inFlight: Promise<TeamsTargetDirectory | undefined> | undefined;

  const enumerate = (): Promise<TeamsTargetDirectory | undefined> => {
    inFlight ??= (async () => {
      const started = now();
      try {
        const directory = await opts.load();
        // Only a directory with at least one readable half is worth keeping;
        // a failure must be looked at again on the next call.
        if (directory.teams.available || directory.chats.available) {
          kept = { at: now(), directory };
        }
        opts.log?.(
          `[teams-targets] enumerated in ${String(now() - started)}ms: teams=${
            directory.teams.available ? String(directory.teams.items.length) : directory.teams.reason
          } chats=${directory.chats.available ? String(directory.chats.items.length) : directory.chats.reason}`,
        );
        return directory;
      } catch (err) {
        opts.log?.(`[teams-targets] enumeration failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    async get(query = {}) {
      if (query.refresh !== true && kept !== undefined && now() - kept.at <= ttlMs) {
        return pageOfTeamsTargets(kept.directory, query);
      }
      const settled = await Promise.race([
        enumerate().then((directory) => ({ directory })),
        sleep(waitMs).then(() => undefined),
      ]);
      if (settled === undefined) return LOADING;
      if (settled.directory === undefined) {
        return {
          teams: { available: false, reason: 'lookup_failed' },
          chats: { available: false, reason: 'lookup_failed' },
        };
      }
      return pageOfTeamsTargets(settled.directory, query);
    },
  };
}
