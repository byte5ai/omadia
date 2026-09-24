/**
 * ONE piece of refresh arithmetic, for every caller that holds a delegated
 * token set (byte5ai/omadia#924/#949).
 *
 * WHY THIS MODULE EXISTS AT ALL
 * -----------------------------
 * A delegated access token lives about an hour; the refresh token behind it
 * lives for weeks. So "the access token is spent" is not a state a human has
 * to fix — it is one silent call away from being fixed — and every caller
 * that treats it as a human problem has invented a dead end.
 *
 * The catalogue upload in `services/teamsProvisioningJob.ts` got this right
 * first, and it got it right in about forty lines: refresh BEFORE the call
 * when the clock says the token is spent, refresh AFTER the call when
 * Microsoft says so, persist every rotation the instant it happens, and give
 * up only when the refresh itself fails. Every one of those four rules is a
 * decision somebody had to make once and would have to make again — and the
 * SECOND caller to need them was the target listing, which instead reported
 * an expired token as "nobody is signed in" and told a signed-in admin to
 * sign in.
 *
 * That is the failure this module exists to make unrepeatable. The same trap
 * had already been sprung once between `describe()` and the runner over the
 * expiry MARGIN, which is why {@link isAccessTokenExpiring} is shared rather
 * than reimplemented; this is the same lesson one level up. Two sites with
 * their own refresh arithmetic drift, and the drift stays invisible until an
 * operator is standing in front of the wrong sentence.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO WRITE, NO REFRESH
 * ─────────────────────────────────────────────────────────────────────────
 * A refresh ROTATES the refresh token: the moment Microsoft answers, the
 * value we held is spent and only the new one works. So a caller that cannot
 * PERSIST the result must not refresh at all — it would trade a recoverable
 * expiry for a silent, permanent sign-out of the whole tenant. That is why
 * custody here is a required write port and not an optional convenience, and
 * why the persist happens on the line after the refresh returns, before
 * anything else can throw.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROACTIVE FAILS SOFT, REACTIVE FAILS LOUD
 * ─────────────────────────────────────────────────────────────────────────
 * The two halves have deliberately opposite failure policies, inherited from
 * the runner:
 *
 *   * {@link refreshExpiringDelegatedTokens} reads OUR clock, so a failure
 *     may well mean our clock is the thing that is wrong. It keeps the stored
 *     token and lets the call proceed — the worst case of trying is exactly
 *     the behaviour of not having tried.
 *   * the reactive half inside {@link withDelegatedTokenRefresh} reads
 *     MICROSOFT'S verdict, which is not a matter of opinion. A refresh that
 *     fails there is the end of the line, and it is the one delegated failure
 *     that genuinely does need a human.
 */

import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  isAccessTokenExpiring,
  isDelegatedConsentRequiredError,
  isDelegatedSignInRequiredError,
  isDelegatedTokenExpiredError,
  isRecoverableByRefresh,
  type DelegatedTokenSet,
} from './teamsDelegatedSignIn.js';

/**
 * Where a rotated token set is persisted. WRITE ONLY — the caller has already
 * read the set it hands in, and a port that could also read would invite a
 * second read racing the rotation this very call is performing.
 */
export interface DelegatedTokenWriter {
  write(tokens: DelegatedTokenSet): Promise<void>;
}

/** The one connector method this module calls. Optional, like every mirrored
 *  contract member: a middleware may be newer than its connector. */
export interface DelegatedRefreshProvisioner {
  refreshDelegatedToken?(input: {
    readonly tokens: DelegatedTokenSet;
  }): Promise<DelegatedTokenSet>;
}

export interface DelegatedRefreshContext {
  readonly provisioner: DelegatedRefreshProvisioner;
  readonly custody: DelegatedTokenWriter;
  readonly now?: () => Date;
  /**
   * Called AFTER a rotation is persisted, never before. The runner turns this
   * into a progress event the operator watches; the listing has nothing to
   * say and leaves it out.
   */
  readonly onRefreshed?: () => Promise<void> | void;
  readonly log?: (msg: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Refresh and persist, as one indivisible act.
 *
 * The write is awaited before the value is returned for the reason spelled
 * out in the module doc: between Microsoft answering and the vault accepting,
 * the only working refresh token exists in a local variable.
 */
async function rotate(
  ctx: DelegatedRefreshContext,
  tokens: DelegatedTokenSet,
): Promise<DelegatedTokenSet> {
  const refresh = ctx.provisioner.refreshDelegatedToken;
  if (typeof refresh !== 'function') return tokens;
  const rotated = await refresh.call(ctx.provisioner, { tokens });
  await ctx.custody.write(rotated);
  await ctx.onRefreshed?.();
  return rotated;
}

/**
 * THE PROACTIVE HALF — refresh before the call, when our clock says the token
 * is spent or close enough to it.
 *
 * NEVER THROWS. See the module doc: this reads our own clock, and a host
 * whose clock is wrong must not be able to fail a call whose token was fine.
 * A failure here leaves the stored set in place and the caller proceeds
 * exactly as it would have without this function — the reactive half is what
 * catches a token that really is dead.
 */
export async function refreshExpiringDelegatedTokens(
  ctx: DelegatedRefreshContext,
  tokens: DelegatedTokenSet,
): Promise<DelegatedTokenSet> {
  const now = ctx.now?.() ?? new Date();
  if (!isAccessTokenExpiring(tokens.expiresAt, now, ACCESS_TOKEN_REFRESH_MARGIN_MS)) {
    return tokens;
  }
  try {
    return await rotate(ctx, tokens);
  } catch (err) {
    ctx.log?.(
      `[teams-delegated] pre-emptive token refresh failed, continuing with the stored token: ${errorMessage(err)}`,
    );
    return tokens;
  }
}

/**
 * Which error to report when a REACTIVE refresh fails.
 *
 * The default is the ORIGINAL expiry error, not the refresh's own. That is
 * deliberate, and it is what makes "the access token expired and could not be
 * renewed" a stable, classifiable outcome for every caller instead of
 * whatever prose the token endpoint happened to return — a listing turning
 * `invalid_grant` into `lookup_failed` would put a retry button in front of a
 * condition no retry can fix.
 *
 * The exception is a refresh that failed with a TYPED delegated error of its
 * own. Those name a DIFFERENT human action — grant consent, sign in — and a
 * more specific actionable answer must never be discarded in favour of a
 * general one.
 */
function reactiveFailure(original: unknown, refreshErr: unknown): unknown {
  if (
    isDelegatedSignInRequiredError(refreshErr) ||
    isDelegatedConsentRequiredError(refreshErr) ||
    isDelegatedTokenExpiredError(refreshErr)
  ) {
    return refreshErr;
  }
  return original;
}

/**
 * Run a delegated call with both halves of the recovery around it: refresh
 * first if the clock says so, and refresh-then-retry-once if Microsoft says
 * so.
 *
 * `run` receives the token set that is actually current — callers must use
 * the ARGUMENT and never close over the set they passed in, or the retry
 * replays the spent token.
 *
 * RETRIED EXACTLY ONCE, and only for an expiry the connector itself marked
 * recoverable. Anything else — including a refresh that failed — travels on
 * to the caller, which is the layer that knows how to say it to a human.
 */
export async function withDelegatedTokenRefresh<T>(
  ctx: DelegatedRefreshContext,
  tokens: DelegatedTokenSet,
  run: (tokens: DelegatedTokenSet) => Promise<T>,
): Promise<T> {
  const current = await refreshExpiringDelegatedTokens(ctx, tokens);
  try {
    return await run(current);
  } catch (err) {
    if (!isDelegatedTokenExpiredError(err) || !isRecoverableByRefresh(err)) throw err;
    if (typeof ctx.provisioner.refreshDelegatedToken !== 'function') throw err;
    let rotated: DelegatedTokenSet;
    try {
      rotated = await rotate(ctx, current);
    } catch (refreshErr) {
      ctx.log?.(
        `[teams-delegated] token refresh after an expiry failed: ${errorMessage(refreshErr)}`,
      );
      throw reactiveFailure(err, refreshErr);
    }
    return run(rotated);
  }
}
