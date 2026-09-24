/**
 * Client boundary for the TENANT Teams sign-in (`/api/v1/operator/teams/*`,
 * byte5ai/omadia#924).
 *
 * WHY IT IS NOT IN `teamsIdentity.ts`. That module is the view of ONE agent's
 * provisioning identity. This one is the view of something the whole
 * deployment shares: a single admin sign-in that every agent — including ones
 * that do not exist yet — provisions through. Keeping them apart in the client
 * mirrors the split the middleware already makes between
 * `/operator/agents/:slug/...` and `/operator/teams/...`, and it stops an
 * agent-shaped mental model from creeping into a tenant-shaped feature.
 *
 * NOTHING HERE CAN SEE A SECRET, and that is a property of the SERVER, not of
 * this file: the route never sends a token, and the device-code `flowHandle`
 * never leaves the middleware process (the poll endpoint takes no body). So
 * there is no redaction to perform here — only parsing. What this module does
 * owe is TOTAL parsing: an older middleware, a proxy that mangles a field, a
 * payload shape from a future version — none of them may take the panel down,
 * because the panel is where an operator goes to fix things.
 *
 * `declined` IS NOT "THE ADMIN CANCELLED". Microsoft returns that verdict for
 * a Conditional Access block, a device-compliance failure and an
 * authentication-method requirement just as readily as for someone pressing
 * cancel. {@link DeviceCodePollView} therefore keeps `reason` and the UI is
 * required to show it — a panel that narrates an intent nobody expressed sends
 * the operator to argue with a colleague instead of with a policy.
 */

import { ApiError } from './api';

// ---------------------------------------------------------------------------
// Transport (verbatim from `_lib/agents.ts` — see its header on why inlined)
// ---------------------------------------------------------------------------

function botApi(path: string): string {
  if (typeof window !== 'undefined') {
    return `/bot-api${path}`;
  }
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

async function forwardCookieHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') return {};
  try {
    const mod = await import('next/headers');
    const jar = await mod.cookies();
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    return cookieHeader ? { cookie: cookieHeader } : {};
  } catch {
    return {};
  }
}

async function callJson<T>(
  path: string,
  init?: RequestInit & { method?: string },
): Promise<T> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(path), {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
    credentials: 'include',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `${init?.method ?? 'GET'} ${path} failed: ${String(res.status)}`,
      text,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// ---------------------------------------------------------------------------
// Error vocabulary — the closed set the middleware answers with
// ---------------------------------------------------------------------------

export const TEAMS_SIGN_IN_ERROR_CODES = [
  /** No sign-in stack in this mount (no vault / boot wiring). */
  'teams_sign_in_unavailable',
  /** No M365 connector installed at all. */
  'teams_provisioner_unavailable',
  /** Connector installed but older than 0.6.0 — an UPGRADE, not an install. */
  'delegated_sign_in_unsupported',
  /** Microsoft refused the flow: publisher app or Conditional Access. */
  'device_code_flow_failed',
  'teams_sign_in_failed',
] as const;

export type TeamsSignInErrorCode = (typeof TEAMS_SIGN_IN_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(TEAMS_SIGN_IN_ERROR_CODES);

/** Total; `null` for anything this build does not recognise, which the panel
 *  renders through its localized fallback with the detail as an argument. */
export function parseTeamsSignInErrorCode(err: unknown): TeamsSignInErrorCode | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === 'string' && ERROR_CODE_SET.has(parsed.error)
      ? (parsed.error as TeamsSignInErrorCode)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface DelegatedAccountView {
  readonly username: string | null;
  readonly displayName: string | null;
}

/** Sign-in state as the panel renders it. Metadata only, by construction. */
export interface TeamsSignInStateView {
  readonly signedIn: boolean;
  /** ISO — when THIS install stored the sign-in ("signed in since"). */
  readonly signedInAt: string | null;
  /** ISO — when the access token expires. */
  readonly expiresAt: string | null;
  /**
   * The access token is past its expiry. NOT signed out: the refresh token
   * outlives it and the next upload refreshes silently. The panel is required
   * to render this as a neutral note, never as an error.
   */
  readonly accessTokenStale: boolean;
  readonly scopes: readonly string[];
  readonly tenantId: string | null;
  readonly account: DelegatedAccountView | null;
}

/** A device-code flow waiting for a human. No handle — see the module header. */
export interface DeviceCodePendingView {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  readonly scopes: readonly string[];
  /** Shown BESIDE the code, before anything fails. */
  readonly adminConsentUrl: string;
}

export interface TeamsSignInStatusView {
  /** The installed connector publishes the delegated half (>= 0.6.0). */
  readonly supported: boolean;
  readonly signIn: TeamsSignInStateView;
  readonly pending: DeviceCodePendingView | null;
}

export type DeviceCodePollView =
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'succeeded'; readonly signIn: TeamsSignInStateView }
  | { readonly status: 'expired'; readonly reason: string | null }
  | { readonly status: 'declined'; readonly reason: string | null }
  | { readonly status: 'no_flow' };

// ---------------------------------------------------------------------------
// Parsing — total, defensive, never throws
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Signed out is the safe default for every shape this build cannot read: it
 *  offers the sign-in button, which is the one action that can never be
 *  wrong here. Claiming a sign-in that does not exist would be. */
export const SIGNED_OUT_VIEW: TeamsSignInStateView = {
  signedIn: false,
  signedInAt: null,
  expiresAt: null,
  accessTokenStale: false,
  scopes: [],
  tenantId: null,
  account: null,
};

export function parseSignInState(value: unknown): TeamsSignInStateView {
  if (!isRecord(value) || value.signedIn !== true) return SIGNED_OUT_VIEW;
  const account = isRecord(value.account)
    ? {
        username: optionalString(value.account.username),
        displayName: optionalString(value.account.displayName),
      }
    : null;
  return {
    signedIn: true,
    signedInAt: optionalString(value.signedInAt),
    expiresAt: optionalString(value.expiresAt),
    accessTokenStale: value.accessTokenStale === true,
    scopes: stringArray(value.scopes),
    tenantId: optionalString(value.tenantId),
    // An account object with neither field is no account at all — rendering
    // an empty "signed in as" line is worse than omitting it.
    account: account && (account.username ?? account.displayName) ? account : null,
  };
}

/**
 * A pending flow, or `null`.
 *
 * The user code and the verification URL are BOTH required: a code with
 * nowhere to type it, or a page with no code, is a dead end rather than a
 * partial success — so a payload missing either drops to "no flow pending"
 * and the panel offers the start button again.
 */
export function parsePendingFlow(value: unknown): DeviceCodePendingView | null {
  if (!isRecord(value)) return null;
  const userCode = optionalString(value.userCode);
  const verificationUri = optionalString(value.verificationUri);
  if (!userCode || !verificationUri) return null;
  const interval = value.intervalSeconds;
  return {
    userCode,
    verificationUri,
    expiresAt: optionalString(value.expiresAt) ?? '',
    intervalSeconds:
      typeof interval === 'number' && Number.isFinite(interval) && interval > 0
        ? Math.ceil(interval)
        : DEFAULT_POLL_INTERVAL_SECONDS,
    scopes: stringArray(value.scopes),
    adminConsentUrl: optionalString(value.adminConsentUrl) ?? '',
  };
}

export function parseSignInStatus(value: unknown): TeamsSignInStatusView {
  const obj = isRecord(value) ? value : {};
  return {
    supported: obj.supported === true,
    signIn: parseSignInState(obj.signIn),
    pending: parsePendingFlow(obj.pending),
  };
}

/**
 * Narrow a poll answer.
 *
 * An unrecognised status becomes `no_flow` rather than an error: the honest
 * consequence is "there is nothing to wait for", which puts the operator back
 * on the start button instead of on a spinner that never resolves.
 */
export function parsePollResult(value: unknown): DeviceCodePollView {
  if (!isRecord(value)) return { status: 'no_flow' };
  switch (value.status) {
    case 'pending': {
      const retry = value.retryAfterSeconds;
      return {
        status: 'pending',
        retryAfterSeconds:
          typeof retry === 'number' && Number.isFinite(retry) && retry > 0
            ? Math.ceil(retry)
            : DEFAULT_POLL_INTERVAL_SECONDS,
      };
    }
    case 'succeeded':
      return { status: 'succeeded', signIn: parseSignInState(value.signIn) };
    case 'expired':
      return { status: 'expired', reason: optionalString(value.reason) };
    case 'declined':
      return { status: 'declined', reason: optionalString(value.reason) };
    default:
      return { status: 'no_flow' };
  }
}

/** Floor for the poll cadence when the server named none. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/**
 * Seconds left on a pending flow, or `null` when it carries no usable expiry.
 *
 * Clamped at zero rather than going negative: a countdown that runs past the
 * deadline into "-14s" reads as a bug, and the honest statement at that point
 * is "expired".
 */
export function secondsRemaining(
  expiresAt: string,
  now: number = Date.now(),
): number | null {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.round((deadline - now) / 1000));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function getTeamsSignInStatus(): Promise<TeamsSignInStatusView> {
  return parseSignInStatus(await callJson<unknown>('/v1/operator/teams/sign-in'));
}

/** 202 — nothing has happened yet; a human still has to type the code. */
export async function startTeamsSignIn(
  displayName?: string,
): Promise<DeviceCodePendingView | null> {
  const body = await callJson<{ pending?: unknown }>('/v1/operator/teams/sign-in', {
    method: 'POST',
    body: JSON.stringify(displayName ? { display_name: displayName } : {}),
  });
  return parsePendingFlow(body?.pending);
}

/** NO ARGUMENTS BY DESIGN — the device code stays on the server. */
export async function pollTeamsSignIn(): Promise<DeviceCodePollView> {
  const body = await callJson<{ poll?: unknown }>('/v1/operator/teams/sign-in/poll', {
    method: 'POST',
  });
  return parsePollResult(body?.poll);
}

export async function revokeTeamsSignIn(): Promise<TeamsSignInStatusView> {
  const body = await callJson<{ signIn?: unknown }>('/v1/operator/teams/sign-in', {
    method: 'DELETE',
  });
  return parseSignInStatus(body?.signIn);
}
