/**
 * The DELEGATED half of `teamsProvisioner@1` — mirrored contract, byte5ai/omadia#924.
 *
 * WHY THIS EXISTS AT ALL. Every other step of Teams provisioning is app-only:
 * the Entra app registration, the Azure bot, the team install. Exactly one is
 * not — `POST /appCatalogs/teamsApps` is delegated-only at Microsoft, with
 * Application permissions documented as "Not supported". No amount of admin
 * consent makes an app-only token work there; a human has to have signed in.
 *
 * So the M365 connector (>= 0.6.0, byte5ai/omadia-m365-connector#12) publishes
 * a device-code sign-in and a delegated catalog upload. An admin signs in ONCE
 * PER TENANT; every agent provisioned afterwards uses the stored token set.
 * That is the whole point of the exercise, and it is why the token set is
 * tenant-scoped state (see `teamsDelegatedTokenStore.ts`) and not something an
 * agent row owns.
 *
 * MIRRORED, NOT IMPORTED — same rule as `teamsProvisionerService.ts`, whose
 * accessor interface these six methods hang off as OPTIONAL members. The
 * connector is not vendored in this checkout and the middleware may be newer
 * than the connector installed next to it, so nothing here may be called
 * without {@link supportsDelegatedCatalogUpload} first.
 *
 * SECRET GRADE, SPELLED OUT. Two values in this module must never reach a
 * log line, an error message, an API response or a progress-event `detail`:
 *
 *   * {@link DelegatedTokenSet.accessToken} / `.refreshToken` — bearer
 *     credentials for the signed-in admin.
 *   * {@link DeviceCodeStart.flowHandle} — it CARRIES the `device_code`.
 *     Anyone holding it during the flow's lifetime can complete the sign-in
 *     against Microsoft themselves.
 *
 * {@link redactDelegated} is the choke point that makes that enforceable
 * rather than aspirational, and `teamsDelegatedRedaction.test.ts` pins it.
 */

// ---------------------------------------------------------------------------
// Token set
// ---------------------------------------------------------------------------

/** The signed-in admin, as far as the operator UI is allowed to care. */
export interface DelegatedAccount {
  readonly username?: string;
  readonly displayName?: string;
  readonly objectId?: string;
  readonly tenantId?: string;
}

/**
 * One tenant's delegated credentials. BOTH tokens are secrets; the rest is
 * metadata the operator screen renders (who, until when, which scopes).
 */
export interface DelegatedTokenSet {
  /** SECRET. */
  readonly accessToken: string;
  /** SECRET. */
  readonly refreshToken: string;
  /** ISO-8601 expiry of {@link accessToken}. */
  readonly expiresAt: string;
  readonly scopes: readonly string[];
  readonly clientId: string;
  readonly tenantId: string;
  readonly account?: DelegatedAccount;
}

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

/** What `startDelegatedSignIn` hands back. */
export interface DeviceCodeStart {
  /** SHOW THIS. The code the admin types on the verification page. */
  readonly userCode: string;
  /** SHOW THIS. Where the admin types it. */
  readonly verificationUri: string;
  /** Microsoft's own sentence; advisory, the UI writes its own copy. */
  readonly message?: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  /**
   * SECRET-GRADE — carries the `device_code`. Stays on the server; see
   * `services/teamsDelegatedSignInService.ts` for how the poll is served
   * without ever handing this to a browser.
   */
  readonly flowHandle: string;
  readonly scopes: readonly string[];
  /**
   * Where an admin grants consent when the sign-in page demands it first.
   * Shown NEXT TO the user code, before anything fails — an operator who
   * only learns about it from an error is an operator already stuck.
   */
  readonly adminConsentUrl: string;
}

export type DeviceCodePollResult =
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'succeeded'; readonly tokens: DelegatedTokenSet }
  | { readonly status: 'expired'; readonly reason?: string }
  | { readonly status: 'declined'; readonly reason?: string };

/**
 * Synchronous verdict on a token set the caller already holds.
 *
 * `accessTokenStale` is NOT signed out. The refresh token outlives the access
 * token by design; a stale access token is one silent refresh away and must
 * never be rendered as a failure or as a prompt to sign in again.
 */
export interface DelegatedSignInStatus {
  readonly signedIn: boolean;
  readonly accessTokenStale?: boolean;
  readonly expiresAt?: string;
  readonly scopes?: readonly string[];
  readonly account?: DelegatedAccount;
  readonly tenantId?: string;
  readonly clientId?: string;
}

export interface DelegatedRevokeResult {
  readonly revoked: boolean;
  readonly reason?: string;
}

export interface UploadToCatalogDelegatedInput {
  readonly packageZip: Uint8Array;
  readonly externalId: string;
  readonly tokens: DelegatedTokenSet;
}

export interface CatalogTeamsAppLike {
  readonly teamsAppId: string;
  readonly externalId?: string;
  readonly displayName?: string;
  readonly version?: string;
}

export interface UploadToCatalogDelegatedResult {
  readonly app: { readonly outcome: string; readonly value: CatalogTeamsAppLike };
  /** Persist when {@link refreshed} is true — the connector rotated them. */
  readonly tokens: DelegatedTokenSet;
  readonly refreshed: boolean;
}

/**
 * The six methods the connector gained in 0.6.0. Declared as a standalone
 * interface so `TeamsProvisionerAccessor` can mix them in as OPTIONAL members
 * without this file having to know about that one.
 */
export interface TeamsDelegatedProvisionerMethods {
  uploadToCatalogDelegated(
    input: UploadToCatalogDelegatedInput,
  ): Promise<UploadToCatalogDelegatedResult>;
  startDelegatedSignIn(input?: {
    readonly displayName?: string;
  }): Promise<DeviceCodeStart>;
  pollDelegatedSignIn(input: {
    readonly flowHandle: string;
  }): Promise<DeviceCodePollResult>;
  /** SYNC by contract — do not await it into a promise-typed seam. */
  getDelegatedSignInStatus(input: {
    readonly tokens?: DelegatedTokenSet;
  }): DelegatedSignInStatus;
  refreshDelegatedToken(input: {
    readonly tokens: DelegatedTokenSet;
  }): Promise<DelegatedTokenSet>;
  /** SYNC by contract. */
  revokeDelegatedSignIn(input: {
    readonly tokens?: DelegatedTokenSet;
  }): DelegatedRevokeResult;
}

/** Structural shape of an accessor that publishes the delegated half. */
export type DelegatedCapableProvisioner = Partial<TeamsDelegatedProvisionerMethods>;

/**
 * Does the CURRENTLY INSTALLED connector publish the delegated catalog upload
 * (>= 0.6.0)? Same shape and same reason as `supportsTeamUninstall` /
 * `supportsTeamLookup`: the contract is mirrored, not imported, so a
 * middleware newer than its connector must ASK before it calls.
 *
 * All six methods are checked together on purpose. They are one feature —
 * a connector that could upload but not sign in would leave the operator with
 * a capability they can never satisfy, and reporting it as available would
 * light up a button that cannot work.
 */
export function supportsDelegatedCatalogUpload(
  provisioner: DelegatedCapableProvisioner | undefined,
): boolean {
  if (provisioner === undefined) return false;
  return (
    typeof provisioner.uploadToCatalogDelegated === 'function' &&
    typeof provisioner.startDelegatedSignIn === 'function' &&
    typeof provisioner.pollDelegatedSignIn === 'function' &&
    typeof provisioner.getDelegatedSignInStatus === 'function' &&
    typeof provisioner.refreshDelegatedToken === 'function' &&
    typeof provisioner.revokeDelegatedSignIn === 'function'
  );
}

// ---------------------------------------------------------------------------
// Error taxonomy — duck-typed guards.
//
// Connector errors cross the plugin boundary as plain `Error`s whose class
// identity belongs to the plugin's module graph, so `instanceof` against a
// local mirror never matches. Same technique as the app-only guards in
// `teamsProvisionerService.ts`.
//
// FOUR ERRORS, FOUR DIFFERENT ACTIONS. That is the entire reason they are
// separate types rather than one `DelegatedError` with a string field: the
// operator must be told to sign in, OR to send an admin to a consent URL, OR
// nothing at all (a refresh happens without them), OR to go look at the
// publisher app's Conditional Access policy. Collapsing them collapses the
// instructions.
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function named(err: unknown, name: string): err is Error {
  return err instanceof Error && err.name === name;
}

export interface DelegatedSignInRequiredLike extends Error {
  readonly name: 'DelegatedSignInRequiredError';
  readonly step?: string;
  readonly requiredScopes?: readonly string[];
}

export interface DelegatedConsentRequiredLike extends Error {
  readonly name: 'DelegatedConsentRequiredError';
  readonly step?: string;
  readonly requiredScopes?: readonly string[];
  readonly adminConsentUrl?: string;
}

/** `access-token-expired` is recoverable without a human; `refresh-token-invalid` is not. */
export type DelegatedTokenExpiredReason =
  | 'access-token-expired'
  | 'refresh-token-invalid';

export interface DelegatedTokenExpiredLike extends Error {
  readonly name: 'DelegatedTokenExpiredError';
  readonly reason?: DelegatedTokenExpiredReason;
  readonly recoverableByRefresh?: boolean;
}

export interface DeviceCodeFlowLike extends Error {
  readonly name: 'DeviceCodeFlowError';
  readonly oauthError?: string;
  readonly status?: number;
}

export function isDelegatedSignInRequiredError(
  err: unknown,
): err is DelegatedSignInRequiredLike {
  return named(err, 'DelegatedSignInRequiredError');
}

export function isDelegatedConsentRequiredError(
  err: unknown,
): err is DelegatedConsentRequiredLike {
  return named(err, 'DelegatedConsentRequiredError');
}

export function isDelegatedTokenExpiredError(
  err: unknown,
): err is DelegatedTokenExpiredLike {
  return named(err, 'DelegatedTokenExpiredError');
}

export function isDeviceCodeFlowError(err: unknown): err is DeviceCodeFlowLike {
  return named(err, 'DeviceCodeFlowError');
}

/** Scopes named by a sign-in / consent error, `[]` when it named none. */
export function requiredScopesOf(err: unknown): readonly string[] {
  const scopes = (err as { requiredScopes?: unknown } | null)?.requiredScopes;
  return isStringArray(scopes) ? scopes : [];
}

/** The step the connector was on, or `undefined` — free text, never copy. */
export function delegatedStepOf(err: unknown): string | undefined {
  const step = (err as { step?: unknown } | null)?.step;
  return typeof step === 'string' && step.length > 0 ? step : undefined;
}

/**
 * The consent URL of a `DelegatedConsentRequiredError`, when it carried one
 * that is safe to put in front of an operator.
 *
 * Validated rather than trusted: only an absolute `https:` URL is returned.
 * The value ends up in a link and in `last_error`, so a `javascript:` or a
 * relative string arriving from another repo's error object must degrade to
 * "no link" instead of being rendered.
 */
export function adminConsentUrlOf(err: unknown): string | undefined {
  const raw = (err as { adminConsentUrl?: unknown } | null)?.adminConsentUrl;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Is a token-expiry failure fixable by a silent refresh (no human)? */
export function isRecoverableByRefresh(err: DelegatedTokenExpiredLike): boolean {
  if (err.recoverableByRefresh === true) return true;
  if (err.recoverableByRefresh === false) return false;
  // An older connector may report the reason without the boolean.
  return err.reason === 'access-token-expired';
}

// ---------------------------------------------------------------------------
// Redaction choke point
// ---------------------------------------------------------------------------

/**
 * Every value in this module that must never be logged, returned or recorded.
 *
 * Kept as data rather than as scattered `delete` statements so the guarantee
 * is testable in one place: `teamsDelegatedRedaction.test.ts` asserts that a
 * payload containing each of these keys comes back without them.
 */
export const DELEGATED_SECRET_KEYS = [
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'flowHandle',
  'flow_handle',
  'deviceCode',
  'device_code',
  'idToken',
  'id_token',
] as const;

const SECRET_KEY_SET: ReadonlySet<string> = new Set(DELEGATED_SECRET_KEYS);

/** Depth bound — a cyclic or absurdly nested payload must not hang a log call. */
const MAX_REDACT_DEPTH = 6;

/**
 * Recursively strip every secret-grade key from a value, so what is left is
 * safe to log, to serialize into an API response, or to write into a
 * progress-event `detail`.
 *
 * Total and non-throwing by construction: it is called from logging and error
 * paths, where a redactor that could itself fail would be worse than the leak
 * it prevents. Unknown types are passed through unchanged; only plain objects
 * and arrays are walked.
 */
export function redactDelegated<T>(value: T, depth = 0): T {
  if (depth >= MAX_REDACT_DEPTH) return undefined as unknown as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactDelegated(entry, depth + 1)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_SET.has(key)) continue;
    out[key] = redactDelegated(entry, depth + 1);
  }
  return out as unknown as T;
}

/**
 * A token set as the OPERATOR may see it: metadata only, both tokens gone.
 * The one projection any route or UI payload is allowed to build from a
 * {@link DelegatedTokenSet}.
 */
export interface DelegatedTokenSummary {
  readonly expiresAt: string;
  readonly scopes: readonly string[];
  readonly clientId: string;
  readonly tenantId: string;
  readonly account?: DelegatedAccount;
}

export function summarizeTokenSet(tokens: DelegatedTokenSet): DelegatedTokenSummary {
  return {
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    clientId: tokens.clientId,
    tenantId: tokens.tenantId,
    ...(tokens.account ? { account: tokens.account } : {}),
  };
}

// ---------------------------------------------------------------------------
// Expiry, and the margin in front of it
// ---------------------------------------------------------------------------

/**
 * How long BEFORE an access token's stated expiry it should be treated as
 * spent — five minutes.
 *
 * WHY A MARGIN AT ALL. Without one, the only way to discover an expired token
 * is to spend a Graph call finding out — and that call is a catalogue upload,
 * a multi-megabyte package that then has to be sent again. Worse, the recovery
 * hinges on the failure coming back as a recognisable
 * `DelegatedTokenExpiredError`; if Graph answers with something else, or a
 * connector classifies it differently, the run fails for a reason no human
 * needs to fix.
 *
 * WHY FIVE MINUTES, rather than thirty seconds or an hour. Three terms bound
 * it:
 *
 *   - THE CALL IT PROTECTS. A catalogue upload takes seconds to tens of
 *     seconds, and a token that was valid when the request left must still be
 *     valid when Graph validates it. Under about a minute leaves that
 *     unguarded.
 *   - CLOCK SKEW against Microsoft. `expiresAt` comes from a token issued on
 *     Microsoft's clock and is compared against ours. An NTP-synced host is
 *     within seconds; a drifted container can be a couple of minutes out in
 *     either direction. Five minutes covers the drift worth covering — a host
 *     further out than that has a problem no margin fixes.
 *   - THE COST OF BEING EARLY. The token lives roughly 60 minutes, so this
 *     refreshes early only in the last ~8% of its life: one extra token
 *     request, occasionally. An hour-wide margin would refresh on essentially
 *     every run and turn a silent optimisation into constant rotation of the
 *     refresh token.
 *
 * It is also the window MSAL uses for its own proactive refresh, so this
 * middleware ages a token on the same schedule as the library the connector
 * refreshes it with, rather than holding a second opinion.
 */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Is this access token past its expiry — or close enough that it should be
 * refreshed before being used?
 *
 * A margin of `0` is the plain question "has it expired", which is what the
 * operator-facing `accessTokenStale` projection asks. The job runner asks the
 * same question with {@link ACCESS_TOKEN_REFRESH_MARGIN_MS}. One rule, two
 * margins — so "stale" on screen and "refresh now" in the runner can never
 * drift into two different definitions of expiry.
 *
 * An UNPARSEABLE `expiresAt` answers `false`. The honest reading of "I cannot
 * tell when this expires" is not "it has expired": treating it as spent would
 * refresh on every single call, and the reactive path still catches a token
 * that really is dead. Wrong in this direction costs one recoverable retry;
 * wrong in the other costs a refresh per run, forever.
 */
export function isAccessTokenExpiring(
  expiresAt: string,
  now: Date,
  marginMs = 0,
): boolean {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - marginMs <= now.getTime();
}
