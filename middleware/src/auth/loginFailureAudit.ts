import type { AdminAuditLog } from './adminAuditLog.js';
import { foldLoginAccountId } from './loginAccount.js';
import { isValidLoginEmail } from './loginEmail.js';

/** One audit row per (account, client) per this window. */
export const LOGIN_FAILURE_WINDOW_MS = 60_000;
/**
 * Upper bound on remembered (account, client) pairs. A spray across many
 * accounts and clients cannot grow the map past it: once it is full, further
 * new pairs inside the window are folded into one overflow row per window.
 */
export const LOGIN_FAILURE_MAX_TRACKED = 10_000;

const OVERFLOW_KEY = '\u0000overflow';
/** A full map is swept at most this often, so a spray cannot buy a scan per request. */
const PRUNE_INTERVAL_MS = 1_000;

/** The `users` row a submitted account names, or undefined when there is none. */
export type ResolveLoginAccount = (
  providerId: string,
  accountId: string,
) => Promise<{ id: string; email: string } | undefined>;

export interface LoginFailure {
  providerId: string;
  /** The account the client asked for, as sent. */
  accountId: string | undefined;
  /** The limiter's client key: an address, an IPv6 prefix or `device:<id>`. */
  clientKey: string;
  /** The provider's `AuthError.code` (`invalid_credentials`, `user_disabled`, …). */
  code: string;
}

export interface LoginFailureReporter {
  report(failure: LoginFailure): void;
}

/**
 * #1315 — failed password sign-ins leave a trace in `admin_audit` and the log.
 *
 * Aggregated like `auth.login_rate_limited`: the FIRST failure of an
 * (account, client) pair in a one-minute window writes one row and one log
 * line; the rest of that window is counted by the limiter, not the table. A
 * brute force against one account is therefore visible (one row per minute
 * per client, plus the limiter's refusal rows once it trips) and cannot flood
 * the table.
 *
 * What is recorded: the client key (target), the provider, the failure code,
 * and the account — but only as the `users` row it names (`account_user_id`
 * and that row's own email), never the submitted string. A submitted value
 * that names no user is recorded as `null`: a password typed into the email
 * field can look like an address (`Summer@2024`), and it must not reach the
 * trail or the log. Without a resolver nothing names the account. The
 * password itself is never seen here.
 */
export function createLoginFailureReporter(opts: {
  audit?: Pick<AdminAuditLog, 'record'>;
  log: (msg: string) => void;
  resolveAccount?: ResolveLoginAccount;
  now?: () => number;
}): LoginFailureReporter {
  const now = opts.now ?? Date.now;
  const windowStart = new Map<string, number>();
  let lastPrune = Number.NEGATIVE_INFINITY;

  const prune = (t: number): void => {
    if (t - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = t;
    for (const [key, start] of windowStart) {
      if (t - start >= LOGIN_FAILURE_WINDOW_MS) windowStart.delete(key);
    }
  };

  /** True when this failure opens a new window for `key` (and so is reported). */
  const opensWindow = (key: string, t: number): boolean => {
    const start = windowStart.get(key);
    if (start !== undefined && t - start < LOGIN_FAILURE_WINDOW_MS) return false;
    windowStart.set(key, t);
    return true;
  };

  return {
    report(failure) {
      const t = now();
      const folded = foldLoginAccountId(failure.accountId);
      let key = `${failure.providerId}\u0000${folded ?? ''}\u0000${failure.clientKey}`;
      if (!windowStart.has(key) && windowStart.size >= LOGIN_FAILURE_MAX_TRACKED) {
        prune(t);
        if (windowStart.size >= LOGIN_FAILURE_MAX_TRACKED) key = OVERFLOW_KEY;
      }
      if (!opensWindow(key, t)) return;

      void record(key === OVERFLOW_KEY ? undefined : failure, folded);
    },
  };

  async function record(failure: LoginFailure | undefined, folded: string | undefined): Promise<void> {
    try {
      if (!failure) {
        opts.log(
          `[auth] login failed — more than ${String(LOGIN_FAILURE_MAX_TRACKED)} distinct account/client pairs this minute; further failures this minute are not itemised`,
        );
        await opts.audit?.record({
          actor: {},
          action: 'auth.login_failed',
          target: 'login:failures-overflow',
          after: { window_s: LOGIN_FAILURE_WINDOW_MS / 1000 },
        });
        return;
      }
      const user = await resolveUser(failure.providerId, folded);
      opts.log(
        `[auth] login failed (${failure.code}) provider=${failure.providerId} client=${failure.clientKey} user=${user?.id ?? '(no such user)'}`,
      );
      await opts.audit?.record({
        actor: {},
        action: 'auth.login_failed',
        target: `login-client:${failure.clientKey}`,
        after: {
          provider: failure.providerId,
          account: user?.email ?? null,
          account_user_id: user?.id ?? null,
          reason: failure.code,
          window_s: LOGIN_FAILURE_WINDOW_MS / 1000,
        },
      });
    } catch (err) {
      console.error(
        '[auth] failed to audit a failed login:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** The user a submitted account names — looked up only for a well-formed address. */
  async function resolveUser(
    providerId: string,
    folded: string | undefined,
  ): Promise<{ id: string; email: string } | undefined> {
    if (!opts.resolveAccount || folded === undefined || !isValidLoginEmail(folded)) return undefined;
    return opts.resolveAccount(providerId, folded);
  }
}
