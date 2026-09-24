/**
 * The ENUMERATION half of `teamsProvisioner@1` — "which teams and chats could
 * this agent be installed into?".
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now an operator TYPED the install target into a free-text field. The
 * field test that produced migration 0054 is the whole argument for this
 * module: a 32-hex string with no prefix is a legal reading of BOTH a team's
 * group id AND the stem of `19:<32hex>@thread.v2`, so
 * `resolveTeamsInstallTarget` is required to refuse it as `'ambiguous'`
 * rather than guess. That refusal is correct and it is still a dead end — the
 * operator is holding a string they cannot disambiguate either.
 *
 * A LIST DISSOLVES THE AMBIGUITY INSTEAD OF REPORTING IT. Every id that comes
 * out of {@link TeamsTargetDirectoryMethods.listTeams} is a hyphenated GUID
 * and every id out of {@link TeamsTargetDirectoryMethods.listChats} carries
 * its `19:…@…` suffix, so both classify unambiguously on the way back in.
 * Picking from a list cannot produce the input that broke the field test.
 *
 * WHY IT IS A SEPARATE MODULE
 * ---------------------------
 * Same reason the delegated half lives in `teamsDelegatedSignIn.ts`: it is a
 * coherent feature of its own, and `teamsProvisionerService.ts` is already at
 * the size where people stop reading it. That module stays the ONE import
 * site — it re-exports everything here — exactly as it does for the delegated
 * methods.
 *
 * THE TWO HALVES ARE NOT SYMMETRIC, AND THAT IS A GRAPH FACT, NOT A CHOICE.
 * `listTeams` is app-only and works wherever the connector is installed.
 * `listChats` CANNOT be: Graph publishes no tenant-wide application route for
 * chats at all — only `/users/{id}/chats`, per user — so chat enumeration is
 * delegated-only and additionally needs {@link CHAT_LISTING_SCOPE}, which the
 * tenant sign-in only started requesting in connector 0.8.0.
 *
 * A credential stored before that CANNOT pick the scope up by refreshing; an
 * admin has to sign in once more. The connector detects this WITHOUT calling
 * Graph and throws {@link DelegatedScopeRequiredLike} — which is why this is
 * modelled as its own state and not as a failure: nothing is broken, one
 * person has to click sign-in once, and then there is a list.
 *
 * VERSION SKEW, AS ALWAYS. Both methods are OPTIONAL on the accessor and each
 * has its own predicate ({@link supportsTeamListing},
 * {@link supportsChatListing}). They are detected SEPARATELY and deliberately:
 * a single combined guard would let an ungranted chat scope hide the team
 * list, which is the one half that always works.
 */

import type { DelegatedTokenSet } from './teamsDelegatedSignIn.js';

/** One row of {@link TeamsTargetDirectoryMethods.listTeams}. */
export interface TeamsTeamSummary {
  /** Hyphenated AAD group id — installs through `POST /teams/{id}/installedApps`. */
  readonly id: string;
  readonly displayName: string;
}

/**
 * What kind of conversation a listed chat is.
 *
 * Spelled the way GRAPH spells it (`oneOnOne`, not `one-on-one`) because this
 * is a mirrored connector contract, not our own vocabulary. The translation
 * into omadia's `TeamsTargetKind` (`'one-on-one-chat'`) happens once, in
 * {@link teamsChatTargetKind}, so no consumer has to remember which spelling
 * it is holding.
 *
 * `'meeting'` is listed because Graph returns it and dropping rows we did not
 * name would make the list quietly incomplete; whether a meeting chat is a
 * sensible install target is the operator's call, not this module's.
 */
export type TeamsChatType = 'group' | 'oneOnOne' | 'meeting';

/** One row of {@link TeamsTargetDirectoryMethods.listChats}. */
export interface TeamsChatSummary {
  /** Full conversation id (`19:…@thread.v2` / `19:…@unq.gbl.spaces`). */
  readonly id: string;
  /**
   * The chat's title, or `null` when it has none — which is the ordinary case
   * for a 1:1 and for many ad-hoc group chats. NOT an error and not a reason
   * to hide the row: {@link memberNames} is what labels those, and an id with
   * no label at all still beats the free-text field this replaces.
   */
  readonly topic: string | null;
  readonly chatType: TeamsChatType;
  /**
   * Display names of the chat's members, when the connector could resolve
   * them. Optional because resolving them is a second Graph call per chat
   * that the connector may skip.
   */
  readonly memberNames?: readonly string[];
}

/** Input of {@link TeamsTargetDirectoryMethods.listChats}. */
export interface ListChatsInput {
  /**
   * The tenant's delegated token set (#949).
   *
   * Chat enumeration is delegated-only — there is no application route for it
   * in Graph — so in practice the connector always needs this. It stays
   * OPTIONAL on the type for one reason: the middleware must not be the party
   * that decides a call is impossible. Handing over whatever token set exists
   * and letting the connector refuse with a typed, explainable error produces
   * a better message than a precondition invented here, and it keeps working
   * if Microsoft ever ships the application route.
   */
  readonly tokens?: DelegatedTokenSet;
}

/**
 * The two enumeration methods, as an interface of their own so the accessor
 * can mix them in with `Partial<…>` (same construction as
 * `TeamsDelegatedProvisionerMethods`).
 */
export interface TeamsTargetDirectoryMethods {
  /**
   * Every team of the tenant the app can see. App-only — no delegated token,
   * no admin sign-in.
   */
  listTeams(): Promise<readonly TeamsTeamSummary[]>;
  /**
   * Every chat the connector can see for the signed-in tenant. DELEGATED
   * ONLY, and needs {@link CHAT_LISTING_SCOPE} — see the module doc. Throws
   * {@link DelegatedScopeRequiredLike} when the stored credential predates
   * that scope.
   */
  listChats(input?: ListChatsInput): Promise<readonly TeamsChatSummary[]>;
}

/**
 * The delegated scope chat enumeration needs, as the tenant sign-in requests
 * it (connector >= 0.8.0).
 *
 * Named here rather than only inside the connector because the operator UI
 * has to be able to SAY what the extra sign-in is for. "Sign in again"
 * without a reason is indistinguishable from a bug.
 */
export const CHAT_LISTING_SCOPE = 'Chat.ReadBasic';

/**
 * The connector refused to enumerate chats because the stored credential
 * predates {@link CHAT_LISTING_SCOPE} (connector >= 0.8.0).
 *
 * THROWN WITHOUT CALLING GRAPH, and that is what makes it worth its own type:
 * the connector can tell from the token set alone, so this is a fast, certain
 * answer rather than a classified 403. And it is NOT recoverable by a
 * refresh — a refresh token can only renew the scopes it was issued for — so
 * the only way out is one interactive sign-in. Treating it as a transient
 * failure would put an operator in front of a retry button that can never
 * work.
 *
 * Duck-typed on `name`, like every other connector error guard.
 */
export interface DelegatedScopeRequiredLike extends Error {
  readonly name: 'DelegatedScopeRequiredError';
  readonly reason: 'scope-missing';
  /** The scopes the sign-in has to be repeated for, when the connector names
   *  them. */
  readonly missingScopes?: readonly string[];
}

export function isDelegatedScopeRequiredError(
  err: unknown,
): err is DelegatedScopeRequiredLike {
  return (
    err instanceof Error &&
    err.name === 'DelegatedScopeRequiredError' &&
    (err as Partial<DelegatedScopeRequiredLike>).reason === 'scope-missing'
  );
}

/** Method names of this half, as data — so a forwarder cannot drift from the
 *  interface above. */
export const TARGET_DIRECTORY_METHOD_NAMES = [
  'listTeams',
  'listChats',
] as const satisfies readonly (keyof TeamsTargetDirectoryMethods)[];

/**
 * Does the CURRENTLY INSTALLED connector publish team enumeration? Same shape
 * and same reason as every other guard in `teamsProvisionerService.ts`: the
 * contract is mirrored, not imported, so a middleware newer than its
 * connector must ASK before it calls.
 */
export function supportsTeamListing(
  provisioner: { readonly listTeams?: unknown } | undefined,
): boolean {
  return typeof provisioner?.listTeams === 'function';
}

/**
 * Does it publish chat enumeration? Checked SEPARATELY from
 * {@link supportsTeamListing} — see the module doc on why the two must not
 * share a predicate.
 */
export function supportsChatListing(
  provisioner: { readonly listChats?: unknown } | undefined,
): boolean {
  return typeof provisioner?.listChats === 'function';
}

/**
 * Translate a listed chat's Graph-spelled type into the `TeamsTargetKind` the
 * rest of omadia stores and renders.
 *
 * A `'meeting'` chat is addressed through the same `19:…@thread.v2` form as a
 * group chat and installs through the same `POST /chats/{id}/installedApps`,
 * so it maps to `'group-chat'`: the discriminator records WHICH GRAPH
 * ENDPOINT installed the app (that is migration 0054's stated purpose), and
 * inventing a fourth kind would have widened a CHECK constraint to record a
 * distinction nothing branches on.
 */
export function teamsChatTargetKind(
  chatType: TeamsChatType,
): 'group-chat' | 'one-on-one-chat' {
  return chatType === 'oneOnOne' ? 'one-on-one-chat' : 'group-chat';
}
