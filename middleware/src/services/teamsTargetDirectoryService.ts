/**
 * "Which teams and chats could this agent be installed into?" — answered in a
 * shape that can say *I don't know*.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ------------------------------------------
 * An empty list and an unavailable list must never look the same. A picker
 * that renders `[]` because the connector is too old, or because nobody has
 * signed in, tells the operator their tenant has no teams — which is a lie,
 * and a lie that makes them go looking in the wrong place. So every listing
 * is a discriminated union: either `available: true` with items (`[]` then
 * genuinely meaning "none"), or `available: false` with a REASON the UI turns
 * into one sentence explaining what to do about it.
 *
 * That is also why nothing here throws. An enumeration is a convenience over
 * a field the operator can still type into; a 500 from the convenience must
 * not take the field down with it.
 *
 * TEAMS AND CHATS DEGRADE INDEPENDENTLY
 * -------------------------------------
 * `listTeams` is app-only and works wherever the connector is installed.
 * `listChats` is delegated-only — Graph has no tenant-wide application route
 * for chats — and additionally needs `Chat.ReadBasic`, which credentials
 * stored before connector 0.8.0 do not carry and cannot obtain by refreshing.
 * They are therefore probed separately and reported separately: a missing
 * chat scope must not be able to hide the team list, which is the half that
 * always works.
 */

import {
  isDelegatedConsentRequiredError,
  isDelegatedSignInRequiredError,
  isDelegatedTokenExpiredError,
  type DelegatedTokenSet,
} from '../platform/teamsDelegatedSignIn.js';
import {
  isDelegatedScopeRequiredError,
  supportsChatListing,
  supportsTeamListing,
  type ListChatsInput,
  type TeamsChatSummary,
  type TeamsTeamSummary,
} from '../platform/teamsTargetDirectory.js';

/**
 * Why a listing is not available.
 *
 * Every value is a machine code the web UI has a sentence for — the router
 * never ships prose it would have to keep in sync with a translation file.
 */
export type TeamsTargetListingUnavailable =
  /** No connector plugin installed/active at all. */
  | 'connector_unavailable'
  /** The installed connector publishes no such method (older version). */
  | 'connector_unsupported'
  /** A tenant admin has to sign in before Graph will answer (#924/#949). */
  | 'sign_in_required'
  /**
   * Somebody IS signed in, but with a credential issued before this listing's
   * scope existed (`Chat.ReadBasic`, connector 0.8.0).
   *
   * Kept apart from `sign_in_required` because the two look identical to the
   * code and completely different to the person: this one means "you are
   * signed in, it still is not enough, sign in once more" — and, crucially,
   * that a refresh will never fix it, because a refresh token only renews the
   * scopes it was issued for. Folding it into `sign_in_required` would put an
   * operator who is demonstrably signed in in front of a message telling them
   * to sign in, with no explanation of why the first time did not count.
   */
  | 'scope_missing'
  /** Signed in, but the tenant never granted the permission at all. */
  | 'consent_required'
  /** Graph answered, badly. Transient far more often than not. */
  | 'lookup_failed';

export type TeamsTargetListing<T> =
  | { readonly available: true; readonly items: readonly T[] }
  | {
      readonly available: false;
      readonly reason: TeamsTargetListingUnavailable;
    };

export interface TeamsTargetDirectory {
  readonly teams: TeamsTargetListing<TeamsTeamSummary>;
  readonly chats: TeamsTargetListing<TeamsChatSummary>;
}

/** The provisioner surface this service uses — structural, both methods
 *  optional, so feature detection reads the object the call would go to. */
export interface TeamsTargetDirectoryProvisioner {
  listTeams?(): Promise<readonly TeamsTeamSummary[]>;
  listChats?(input?: ListChatsInput): Promise<readonly TeamsChatSummary[]>;
}

export interface TeamsTargetDirectoryOptions {
  /** `undefined` when the connector plugin is not installed/active. */
  readonly getProvisioner: () => TeamsTargetDirectoryProvisioner | undefined;
  /** The tenant sign-in, when one is wired. Absent is not an error — it only
   *  means `listChats` is called without tokens and the connector decides. */
  readonly delegatedTokens?: { read(): Promise<DelegatedTokenSet | undefined> };
  readonly log?: (msg: string) => void;
}

/**
 * Classify a thrown enumeration failure.
 *
 * The three delegated guards come first because they are the only ones that
 * name a HUMAN ACTION: "sign in", "grant consent". Reporting either of those
 * as `lookup_failed` would put an operator in front of a retry button for a
 * condition no retry can fix.
 */
function classifyListingFailure(err: unknown): TeamsTargetListingUnavailable {
  // FIRST, and deliberately: the connector raises this one WITHOUT calling
  // Graph, from the token set alone, so it is the most certain answer
  // available and the only one that says "the sign-in you already have is
  // the wrong shape" rather than "there is no sign-in".
  if (isDelegatedScopeRequiredError(err)) return 'scope_missing';
  if (isDelegatedSignInRequiredError(err)) return 'sign_in_required';
  if (isDelegatedTokenExpiredError(err)) return 'sign_in_required';
  if (isDelegatedConsentRequiredError(err)) return 'consent_required';
  return 'lookup_failed';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Both listings, each degraded on its own.
 *
 * Deliberately sequential rather than `Promise.all`: these are two Graph
 * enumerations fired from an operator screen that may be polled, and the
 * throttling budget they share is the connector's. The latency of one extra
 * round trip is not worth a 429 that turns BOTH halves into `lookup_failed`.
 */
export async function loadTeamsTargetDirectory(
  opts: TeamsTargetDirectoryOptions,
): Promise<TeamsTargetDirectory> {
  const provisioner = opts.getProvisioner();
  if (provisioner === undefined) {
    return {
      teams: { available: false, reason: 'connector_unavailable' },
      chats: { available: false, reason: 'connector_unavailable' },
    };
  }
  return {
    teams: await listTeamsSafely(opts, provisioner),
    chats: await listChatsSafely(opts, provisioner),
  };
}

async function listTeamsSafely(
  opts: TeamsTargetDirectoryOptions,
  provisioner: TeamsTargetDirectoryProvisioner,
): Promise<TeamsTargetListing<TeamsTeamSummary>> {
  if (!supportsTeamListing(provisioner)) {
    return { available: false, reason: 'connector_unsupported' };
  }
  try {
    const items = await (
      provisioner.listTeams as NonNullable<
        TeamsTargetDirectoryProvisioner['listTeams']
      >
    ).call(provisioner);
    return { available: true, items };
  } catch (err) {
    opts.log?.(`[teams-targets] listTeams failed: ${errorMessage(err)}`);
    return { available: false, reason: classifyListingFailure(err) };
  }
}

async function listChatsSafely(
  opts: TeamsTargetDirectoryOptions,
  provisioner: TeamsTargetDirectoryProvisioner,
): Promise<TeamsTargetListing<TeamsChatSummary>> {
  if (!supportsChatListing(provisioner)) {
    return { available: false, reason: 'connector_unsupported' };
  }
  // Read the token set but do NOT gate on it, even though chat enumeration is
  // known to be delegated-only (Graph has no tenant-wide application route
  // for chats). The connector distinguishes "no sign-in" from "sign-in
  // without `Chat.ReadBasic`" and only it can tell them apart; a
  // `sign_in_required` invented here would collapse the two and tell an admin
  // who IS signed in to sign in, with no hint that the scope is what changed.
  let tokens: DelegatedTokenSet | undefined;
  try {
    tokens = await opts.delegatedTokens?.read();
  } catch (err) {
    opts.log?.(`[teams-targets] delegated token read failed: ${errorMessage(err)}`);
  }
  try {
    const items = await (
      provisioner.listChats as NonNullable<
        TeamsTargetDirectoryProvisioner['listChats']
      >
    ).call(provisioner, tokens === undefined ? undefined : { tokens });
    return { available: true, items };
  } catch (err) {
    opts.log?.(`[teams-targets] listChats failed: ${errorMessage(err)}`);
    return { available: false, reason: classifyListingFailure(err) };
  }
}
