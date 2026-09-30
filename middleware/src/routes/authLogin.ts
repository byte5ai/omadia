import type { Request, RequestHandler, Response } from 'express';

import type { AdminAuditLog } from '../auth/adminAuditLog.js';
import {
  clientAddressFor,
  describeClientAddressPolicy,
  parseClientAddressPolicy,
  type ClientAddressPolicy,
} from '../auth/clientAddress.js';
import {
  LOGIN_DEVICE_COOKIE,
  setLoginDeviceCookie,
  type LoginDeviceCookies,
} from '../auth/loginDeviceCookie.js';
import {
  createLoginRateLimiter,
  DEFAULT_LOGIN_LIMITER_CONFIG,
  loginAccountKey,
  readLoginAccountId,
  type LoginAttempt,
  type LoginRateLimiter,
  type LoginRefusal,
} from '../auth/loginRateLimiter.js';
import {
  isPasswordProvider,
  type AuthResult,
  type AuthSuccess,
  type PasswordProvider,
} from '../auth/providers/AuthProvider.js';
import type { ProviderRegistry } from '../auth/providerRegistry.js';

/**
 * `POST /api/v1/auth/login/:providerId` — password sign-in behind the login
 * rate limiter (docs/security-architecture.md §10f).
 *
 * Order, cheapest first:
 *   1. unknown or non-password provider → 404 (no budget spent, no argon2);
 *   2. the limiter: client layer, (account, client) pair, global capacity →
 *      429 `auth.rate_limited` / 503 `auth.busy`, both with `Retry-After` and
 *      `retry_after_s`, never a cookie and never a `verify` call;
 *   3. `provider.verify` (argon2) inside the admitted attempt; anything but a
 *      success counts as a failure, a throw included;
 *   4. success: session cookie plus a fresh device cookie for this account.
 *
 * The client key is the device id when the request carries a genuine device
 * cookie for THIS account, otherwise the `AUTH_LOGIN_CLIENT_ADDRESS` address.
 */

/** Everything the limiter needs at the route. */
export interface LoginGuardDeps {
  limiter: LoginRateLimiter;
  /** Where the client address comes from (`AUTH_LOGIN_CLIENT_ADDRESS`). */
  clientAddress: ClientAddressPolicy;
  /** One `auth.login_rate_limited` row per refusal episode — never the account. */
  audit?: Pick<AdminAuditLog, 'record'>;
}

/**
 * What a router uses when nothing is wired: the defaults and the socket
 * address. The guard is never off — a forgotten wiring cannot disable it.
 */
export function defaultLoginGuard(): LoginGuardDeps {
  return { limiter: createLoginRateLimiter(), clientAddress: { kind: 'socket' } };
}

/** The production guard: one limiter per process, swept every minute. */
export function createLoginGuard(opts: {
  /** `AUTH_LOGIN_CLIENT_ADDRESS`, already validated by the config schema. */
  clientAddress: string;
  /** `AUTH_LOGIN_MAX_INFLIGHT`. */
  maxInFlight: number;
  audit?: Pick<AdminAuditLog, 'record'>;
  log?: (msg: string) => void;
}): LoginGuardDeps {
  const limiter = createLoginRateLimiter({
    ...DEFAULT_LOGIN_LIMITER_CONFIG,
    globalMaxInFlight: opts.maxInFlight,
  });
  const sweeper = setInterval(() => limiter.sweep(), DEFAULT_LOGIN_LIMITER_CONFIG.sweepIntervalMs);
  sweeper.unref();
  const clientAddress = parseClientAddressPolicy(opts.clientAddress);
  (opts.log ?? ((m: string) => console.log(m)))(
    `[auth] login rate limiter armed (client address=${describeClientAddressPolicy(clientAddress)}, max in-flight=${String(opts.maxInFlight)}; in-memory, per process)`,
  );
  return { limiter, clientAddress, ...(opts.audit ? { audit: opts.audit } : {}) };
}

export interface PasswordLoginDeps {
  registry: Pick<ProviderRegistry, 'get'>;
  guard: LoginGuardDeps;
  devices: LoginDeviceCookies;
  /** Mints the session cookie (the auth router owns session minting). */
  signIn: (
    req: Request,
    res: Response,
    success: AuthSuccess,
    provider: PasswordProvider,
  ) => Promise<void>;
  log?: (msg: string) => void;
}

export function createPasswordLoginHandler(deps: PasswordLoginDeps): RequestHandler {
  const log = deps.log ?? ((m: string) => console.warn(m));

  return async (req: Request, res: Response) => {
    const id = readProviderId(req);
    const provider = id ? deps.registry.get(id) : undefined;
    if (!provider || !isPasswordProvider(provider)) {
      res.status(404).json({ code: 'auth.unknown_provider' });
      return;
    }

    const accountKey = loginAccountKey(provider.id, readLoginAccountId(req.body));
    const deviceId = deps.devices.deviceIdFor(readCookie(req, LOGIN_DEVICE_COOKIE), accountKey);
    const clientKey = deviceId
      ? `device:${deviceId}`
      : clientAddressFor(req, deps.guard.clientAddress);

    const admission = deps.guard.limiter.admit({ clientKey, accountKey });
    if (!admission.allowed) {
      if (admission.report) reportRefusal(deps.guard, admission, clientKey, log);
      refuse(res, admission);
      return;
    }

    const result = await verifyCounted(provider, req.body, admission.attempt);
    if (result.outcome === 'error') {
      res.status(httpForAuthErrorCode(result.code)).json({ code: `auth.${result.code}` });
      return;
    }

    await deps.signIn(req, res, result, provider);
    setLoginDeviceCookie(req, res, deps.devices.mint(accountKey));
    res.json({ ok: true, user: userPayload(result, provider) });
  };
}

/** Run `verify` inside an admitted attempt; only a success is not a failure. */
async function verifyCounted(
  provider: PasswordProvider,
  body: unknown,
  attempt: LoginAttempt,
): Promise<AuthResult> {
  let succeeded = false;
  try {
    const result = await provider.verify(body);
    succeeded = result.outcome === 'success';
    return result;
  } finally {
    if (succeeded) attempt.succeed();
    else attempt.fail();
  }
}

function refuse(res: Response, refusal: LoginRefusal): void {
  const busy = refusal.scope === 'global';
  res.set('Retry-After', String(refusal.retryAfterS));
  res.status(busy ? 503 : 429).json({
    code: busy ? 'auth.busy' : 'auth.rate_limited',
    retry_after_s: refusal.retryAfterS,
  });
}

/**
 * One log line and one audit row per refusal episode. The client key is a
 * validated address, an IPv6 /64 or `device:<id>`, so it cannot forge a log
 * line; the account never appears (the same rule as `AuthError.message`).
 */
function reportRefusal(
  guard: LoginGuardDeps,
  refusal: LoginRefusal,
  clientKey: string,
  log: (msg: string) => void,
): void {
  log(
    `[auth] login refused (${refusal.scope} limit) client=${clientKey} retry_after_s=${String(refusal.retryAfterS)}`,
  );
  if (!guard.audit) return;
  guard.audit
    .record({
      actor: {},
      action: 'auth.login_rate_limited',
      target: refusal.scope === 'global' ? 'login:capacity' : `login-client:${clientKey}`,
      after: { scope: refusal.scope, retry_after_s: refusal.retryAfterS },
    })
    .catch((err: unknown) => {
      console.error(
        '[auth] failed to audit a login refusal:',
        err instanceof Error ? err.message : err,
      );
    });
}

/** Maps a provider's `AuthError.code` to the HTTP status of the sign-in answer. */
export function httpForAuthErrorCode(code: string): number {
  switch (code) {
    case 'invalid_credentials':
    case 'user_disabled':
    case 'unknown_user':
      return 401;
    case 'state_mismatch':
    case 'callback_invalid':
      return 400;
    case 'idp_error':
    default:
      return 502;
  }
}

function readProviderId(req: Request): string | undefined {
  const v = (req.params as Record<string, string | string[] | undefined>)['providerId'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readCookie(req: Request, name: string): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[name];
}

function userPayload(
  success: AuthSuccess,
  provider: { id: string },
): {
  id: string;
  email: string;
  display_name: string;
  role: 'admin';
  provider: string;
} {
  return {
    id: success.providerUserId,
    email: success.email,
    display_name: success.displayName,
    role: 'admin',
    provider: provider.id,
  };
}
