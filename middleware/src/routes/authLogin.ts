import type { Request, RequestHandler, Response } from 'express';

import type { AdminAuditLog } from '../auth/adminAuditLog.js';
import {
  clientAddressFor,
  DEFAULT_IPV6_PREFIX_BITS,
  describeClientAddressPolicy,
  parseClientAddressPolicy,
  type ClientAddressPolicy,
} from '../auth/clientAddress.js';
import { loginAccountKey, readLoginAccountId } from '../auth/loginAccount.js';
import {
  createLoginDevices,
  usersTableEpochs,
  type LoginAccount,
  type LoginDevices,
} from '../auth/loginDevices.js';
import {
  createLoginRateLimiter,
  DEFAULT_LOGIN_LIMITER_CONFIG,
  type LoginAttempt,
  type LoginKeys,
  type LoginRateLimiter,
  type LoginRefusal,
} from '../auth/loginRateLimiter.js';
import {
  isPasswordProvider,
  type AuthSuccess,
  type PasswordAuthResult,
  type PasswordAuthSuccess,
  type PasswordProvider,
} from '../auth/providers/AuthProvider.js';
import type { ProviderRegistry } from '../auth/providerRegistry.js';
import type { UserStore } from '../auth/userStore.js';

/**
 * `POST /api/v1/auth/login/:providerId` — password sign-in behind the login
 * rate limiter (docs/security-architecture.md §10m).
 *
 * Order, cheapest first:
 *   1. unknown or non-password provider → 404 (no budget spent, no argon2);
 *   2. the limiter: client layer, (account, client) pair, global capacity →
 *      429 `auth.rate_limited` / 503 `auth.busy`, both with `Retry-After` and
 *      `retry_after_s`, never a cookie and never a `verify` call;
 *   3. `provider.verify` (argon2) inside the admitted attempt; anything but a
 *      success counts as a failure, a throw included;
 *   4. success: session cookie for the `users` row the provider verified
 *      (`PasswordAuthSuccess.account`: its session version comes from the
 *      same read that checked the password, §10k) plus a fresh device cookie
 *      for that account — its address as stored, never the one typed — under
 *      the credential epoch the provider checked, never one read afterwards
 *      (a success without one gets no device cookie).
 *
 * The account key folds the typed address at least as coarsely as the users
 * table matches it (`auth/loginAccount.ts`). The client key is the device id
 * when the request carries a current device cookie for the account the typed
 * address names (kind `device`: genuine, minted by a sign-in to that account
 * that checked its current password — `auth/loginDevices.ts`), otherwise the
 * `AUTH_LOGIN_CLIENT_ADDRESS` address — `address` when a trusted hop vouched
 * for it, `shared` when it is the TCP peer (the limiter header says why the
 * kind matters).
 */

/** Everything the limiter needs at the route. */
export interface LoginGuardDeps {
  limiter: LoginRateLimiter;
  /** Where the client address comes from (`AUTH_LOGIN_CLIENT_ADDRESS`). */
  clientAddress: ClientAddressPolicy;
  /** IPv6 clients are keyed by this prefix (`AUTH_LOGIN_IPV6_PREFIX`, default /64). */
  ipv6PrefixBits?: number;
  /** One `auth.login_rate_limited` row per refusal episode — never the account. */
  audit?: Pick<AdminAuditLog, 'record'>;
  /**
   * The device cookies the limiter honours. Absent → the auth router builds
   * them from its own signing key and user store. Production passes the
   * process-wide instance so the admin routes can revoke through it.
   */
  devices?: LoginDevices;
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
  /** `AUTH_LOGIN_IPV6_PREFIX`. */
  ipv6PrefixBits?: number;
  /** The session signing key; the device-cookie keys are derived from it. */
  signingKey: Uint8Array;
  /** Where a device cookie's account epoch is read (`auth/loginDevices.ts`). */
  accounts: Pick<UserStore, 'findByEmailWithHash'>;
  audit?: Pick<AdminAuditLog, 'record'>;
  log?: (msg: string) => void;
}): LoginGuardDeps & { devices: LoginDevices } {
  const limiter = createLoginRateLimiter({
    ...DEFAULT_LOGIN_LIMITER_CONFIG,
    globalMaxInFlight: opts.maxInFlight,
  });
  const sweeper = setInterval(() => limiter.sweep(), DEFAULT_LOGIN_LIMITER_CONFIG.sweepIntervalMs);
  sweeper.unref();
  const clientAddress = parseClientAddressPolicy(opts.clientAddress);
  const ipv6PrefixBits = opts.ipv6PrefixBits ?? DEFAULT_IPV6_PREFIX_BITS;
  (opts.log ?? ((m: string) => console.log(m)))(
    `[auth] login rate limiter armed (client address=${describeClientAddressPolicy(clientAddress)}, IPv6 prefix=/${String(ipv6PrefixBits)}, max in-flight=${String(opts.maxInFlight)}; in-memory, per process)`,
  );
  return {
    limiter,
    clientAddress,
    ipv6PrefixBits,
    devices: createLoginDevices({
      signingKey: opts.signingKey,
      epochs: usersTableEpochs(opts.accounts),
    }),
    ...(opts.audit ? { audit: opts.audit } : {}),
  };
}

export interface PasswordLoginDeps {
  registry: Pick<ProviderRegistry, 'get'>;
  guard: LoginGuardDeps;
  devices: LoginDevices;
  /**
   * Mints the session cookie (the auth router owns session minting) for the
   * `users` row the provider verified (`success.account`).
   */
  signIn: (
    req: Request,
    res: Response,
    success: PasswordAuthSuccess,
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

    const account: LoginAccount = { providerId: provider.id, accountId: readLoginAccountId(req.body) };
    const keys = await loginKeysFor(req, account, deps);
    const admission = deps.guard.limiter.admit(keys);
    if (!admission.allowed) {
      if (admission.report) reportRefusal(deps.guard, admission, keys.clientKey, log);
      refuse(res, admission);
      return;
    }

    const result = await verifyCounted(provider, req.body, admission.attempt);
    if (result.outcome === 'error') {
      res.status(httpForAuthErrorCode(result.code)).json({ code: `auth.${result.code}` });
      return;
    }

    await deps.signIn(req, res, result, provider);
    if (result.credentialEpoch !== undefined) {
      deps.devices.remember(req, res, {
        providerId: provider.id,
        email: result.email,
        epoch: result.credentialEpoch,
      });
    }
    res.json({ ok: true, user: userPayload(result, provider) });
  };
}

/** The limiter keys of a sign-in attempt: a current device cookie for THIS account, else the address. */
async function loginKeysFor(
  req: Request,
  account: LoginAccount,
  deps: PasswordLoginDeps,
): Promise<LoginKeys> {
  const accountKey = loginAccountKey(account.providerId, account.accountId);
  const deviceId = await deps.devices.knownDeviceOf(req, account);
  if (deviceId) return { clientKey: `device:${deviceId}`, clientKind: 'device', accountKey };
  const address = clientAddressFor(req, deps.guard.clientAddress, deps.guard.ipv6PrefixBits);
  return { clientKey: address.key, clientKind: address.shared ? 'shared' : 'address', accountKey };
}

/** Run `verify` inside an admitted attempt; only a success is not a failure. */
async function verifyCounted(
  provider: PasswordProvider,
  body: unknown,
  attempt: LoginAttempt,
): Promise<PasswordAuthResult> {
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
 * validated address, an IPv6 prefix or `device:<id>`, so it cannot forge a
 * log line; the account never appears (the same rule as `AuthError.message`).
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
