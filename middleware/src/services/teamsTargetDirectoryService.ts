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
 *
 * A SPENT ACCESS TOKEN IS NOT A MISSING SIGN-IN
 * ---------------------------------------------
 * This listing used to report an expired access token as `sign_in_required`,
 * which put an operator who was demonstrably signed in — account on screen,
 * tenant sign-in green — in front of the sentence "sign in once". It was
 * wrong twice over: the sign-in existed, and the expiry needed no human at
 * all, only the refresh the catalogue upload had been doing since #924.
 *
 * So the listing now performs that refresh itself, through the SHARED
 * arithmetic in `platform/teamsDelegatedRefresh.ts` rather than a second copy
 * of it — the drift between two hand-rolled refresh paths is exactly the trap
 * that had already been sprung once between `describe()` and the runner.
 *
 * The refresh is not only a repair, it is what makes the REAL diagnosis
 * reachable. The connector validates a token before it considers what the
 * token is allowed to do, so while the access token was spent, the expiry was
 * the only error it ever threw and {@link classifyListingFailure}'s scope
 * branch could not be reached however correctly it was ordered. With a live
 * token the connector gets far enough to notice a missing `Chat.ReadBasic`,
 * and the operator is finally told the thing that is actually true.
 */

import {
  isDelegatedConsentRequiredError,
  isDelegatedSignInRequiredError,
  isDelegatedTokenExpiredError,
  type DelegatedTokenSet,
} from '../platform/teamsDelegatedSignIn.js';
import {
  withDelegatedTokenRefresh,
  type DelegatedRefreshProvisioner,
} from '../platform/teamsDelegatedRefresh.js';
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
  /**
   * NOBODY IS SIGNED IN. That is the whole meaning of this code, and it is
   * now the only one — see `sign_in_expired` below for what used to be folded
   * in here and for why that was the field-test bug (#924/#949).
   */
  | 'sign_in_required'
  /**
   * Somebody IS signed in, the access token is spent, and renewing it failed.
   *
   * The admin does have to sign in again, so the ACTION is the same as
   * `sign_in_required` — and that is precisely why the two must stay apart.
   * "You never signed in" and "your sign-in stopped working" send a person to
   * the same button with completely different expectations, and only one of
   * them is worth investigating (a revoked session, a password change, a
   * Conditional Access policy). Folding them together is what produced a
   * screen telling a signed-in admin to sign in, with no hint that anything
   * had expired.
   *
   * Reaching this code at all means the refresh was TRIED and failed: a spent
   * access token whose refresh works never surfaces to a human.
   */
  | 'sign_in_expired'
  /**
   * Somebody IS signed in, with a credential issued before this listing's
   * scope existed (`Chat.ReadBasic`, connector 0.8.0).
   *
   * Kept apart from both codes above because a refresh will never fix it — a
   * refresh token only renews the scopes it was issued for — so this is the
   * one case where signing in again is genuinely the only way forward, and
   * the copy can say why the first sign-in did not count.
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

/** The provisioner surface this service uses — structural, every method
 *  optional, so feature detection reads the object the call would go to. */
export interface TeamsTargetDirectoryProvisioner extends DelegatedRefreshProvisioner {
  listTeams?(): Promise<readonly TeamsTeamSummary[]>;
  listChats?(input?: ListChatsInput): Promise<readonly TeamsChatSummary[]>;
}

export interface TeamsTargetDirectoryOptions {
  /** `undefined` when the connector plugin is not installed/active. */
  readonly getProvisioner: () => TeamsTargetDirectoryProvisioner | undefined;
  /**
   * The tenant sign-in, when one is wired. Absent is not an error — it only
   * means `listChats` is called without tokens and the connector decides.
   *
   * `write` is OPTIONAL and its absence is load-bearing: without somewhere to
   * persist a rotation this listing must not refresh at all. A refresh spends
   * the refresh token the instant Microsoft answers, so rotating without
   * recording the result would trade a recoverable expiry for a silent,
   * permanent sign-out of the entire tenant. One bad sentence is the cheaper
   * failure. See `platform/teamsDelegatedRefresh.ts`.
   */
  readonly delegatedTokens?: {
    read(): Promise<DelegatedTokenSet | undefined>;
    write?(tokens: DelegatedTokenSet): Promise<void>;
  };
  /** Wall clock, injectable — the proactive refresh reads it, and that
   *  decision has to be testable without waiting an hour. */
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
}

/**
 * Classify a thrown enumeration failure.
 *
 * The delegated guards come first because they are the only ones that name a
 * HUMAN ACTION: "sign in", "grant consent". Reporting any of those as
 * `lookup_failed` would put an operator in front of a retry button for a
 * condition no retry can fix.
 *
 * ON THE ORDER, AND ON WHAT THE ORDER CANNOT DO. It is written most-specific
 * first, and that is right — but ordering alone never made `scope_missing`
 * reachable for the operator who reported this. Only ONE error is ever
 * thrown, and while the access token was spent that error was always the
 * expiry: the connector will not scope-check a credential it cannot
 * authenticate. What made the scope answer reachable is the refresh in
 * {@link listChatsSafely}, not this list.
 */
function classifyListingFailure(err: unknown): TeamsTargetListingUnavailable {
  // FIRST, and deliberately: the connector raises this one WITHOUT calling
  // Graph, from the token set alone, so it is the most certain answer
  // available and the only one that says "the sign-in you already have is
  // the wrong shape" rather than "there is no sign-in".
  if (isDelegatedScopeRequiredError(err)) return 'scope_missing';
  if (isDelegatedSignInRequiredError(err)) return 'sign_in_required';
  // NOT `sign_in_required`. Getting here means a refresh was attempted and
  // did not work — the whole recoverable case is handled upstream and never
  // reaches a human.
  if (isDelegatedTokenExpiredError(err)) return 'sign_in_expired';
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

  const listChats = provisioner.listChats as NonNullable<
    TeamsTargetDirectoryProvisioner['listChats']
  >;
  const call = (set: DelegatedTokenSet | undefined): Promise<readonly TeamsChatSummary[]> =>
    listChats.call(provisioner, set === undefined ? undefined : { tokens: set });

  const write = opts.delegatedTokens?.write;
  try {
    // NO WRITE, NO REFRESH — and no refresh method, nothing to call. Either
    // way the listing behaves exactly as it did before #949: it spends the
    // token it was given and reports whatever comes back.
    const items =
      tokens === undefined || write === undefined
        ? await call(tokens)
        : await withDelegatedTokenRefresh(
            {
              provisioner,
              custody: { write: (set) => write.call(opts.delegatedTokens, set) },
              ...(opts.now ? { now: opts.now } : {}),
              ...(opts.log ? { log: opts.log } : {}),
            },
            tokens,
            // The ARGUMENT, never the captured `tokens` — a retry that
            // replayed the spent set would fail identically forever.
            (set) => call(set),
          );
    return { available: true, items };
  } catch (err) {
    opts.log?.(`[teams-targets] listChats failed: ${errorMessage(err)}`);
    return { available: false, reason: classifyListingFailure(err) };
  }
}
