/**
 * Process-wide canonical store for provider OAuth tokens (phase 4b).
 *
 * WHY THIS EXISTS: auth.openai.com ROTATES refresh tokens (a rotated-away
 * token later reused is a terminal `refresh_token_reused` error). The three
 * LLM plugins (orchestrator / verifier / orchestrator-extras) each hold a
 * scope-bound vault copy of the tokens; if each refreshed independently, the
 * first rotation would kill the other two copies. So:
 *
 *  - ONE in-memory canonical copy per providerId, shared by every caller in
 *    the process (the plugins are in-process packages).
 *  - ONE in-flight refresh at a time (single-flight promise) — a stampede is
 *    structurally impossible.
 *  - Rotated tokens are persisted through a boot-registered binding that fans
 *    them out to ALL vault scopes (plus an `oauth_updated_at` stamp) BEFORE
 *    the refresh promise resolves.
 *  - On restart, hydration reads every scope and takes the NEWEST copy
 *    (`oauth_updated_at`), so a crash between per-scope writes self-heals
 *    instead of resurrecting a pre-rotation refresh token.
 *  - A terminal refresh failure (grant dead) parks the provider in
 *    `reconnect_required` — no retry hammering; the operator re-runs the
 *    30-second device flow, which re-primes the store.
 */
import {
  isAccessTokenExpired,
  OAuthReconnectRequiredError,
  refreshAccessToken,
  OPENAI_CODEX_OAUTH,
  type FetchLike,
  type NowMs,
  type OAuthClientConfig,
  type OAuthTokens,
} from './oauthDeviceFlow.js';

export interface ProviderOAuthStoreBinding {
  /** Read every scope's copy; the store keeps the newest by `updatedAt`. */
  readonly load: () => Promise<
    ReadonlyArray<{ tokens: OAuthTokens; updatedAt: number }>
  >;
  /** Fan the (possibly rotated) tokens out to every scope. */
  readonly persist: (tokens: OAuthTokens, updatedAtMs: number) => Promise<void>;
}

/** Injectable deps for {@link getProviderOAuthBearer} (test seam). */
export interface ProviderOAuthDeps {
  readonly fetchImpl?: FetchLike;
  readonly config?: OAuthClientConfig;
  readonly nowMs?: NowMs;
  readonly log?: (...args: unknown[]) => void;
}

interface StoreEntry {
  tokens?: OAuthTokens;
  /** In-flight (or settled) hydration — a PROMISE, not a bool, so a second
   *  concurrent caller awaits the same load instead of racing past a
   *  half-populated entry (the production binding spans many vault reads). */
  hydration?: Promise<void>;
  state: 'ok' | 'reconnect_required';
  inflight?: Promise<string>;
}

const entries = new Map<string, StoreEntry>();
const bindings = new Map<string, ProviderOAuthStoreBinding>();

function entry(providerId: string): StoreEntry {
  let e = entries.get(providerId);
  if (!e) {
    e = { state: 'ok' };
    entries.set(providerId, e);
  }
  return e;
}

/** Boot-time registration (app layer owns non-scope-bound vault access). */
export function registerProviderOAuthStoreBinding(
  providerId: string,
  binding: ProviderOAuthStoreBinding,
): void {
  bindings.set(providerId, binding);
  // A re-registration (e.g. plugin reactivation) must re-hydrate.
  entries.delete(providerId);
}

/** Prime the store right after a successful connect (poll route). Marks
 *  hydration as already done and clears any reconnect latch. */
export function primeProviderOAuthTokens(
  providerId: string,
  tokens: OAuthTokens,
): void {
  entries.set(providerId, {
    tokens,
    hydration: Promise.resolve(),
    state: 'ok',
  });
}

/** Whether the provider needs a fresh device-flow connect. */
export function isProviderOAuthReconnectRequired(providerId: string): boolean {
  return entries.get(providerId)?.state === 'reconnect_required';
}

function hydrate(providerId: string, e: StoreEntry): Promise<void> {
  if (e.hydration) return e.hydration;
  const binding = bindings.get(providerId);
  e.hydration = (async () => {
    if (!binding) return;
    const copies = await binding.load();
    let best: { tokens: OAuthTokens; updatedAt: number } | undefined;
    for (const c of copies) {
      if (!best || c.updatedAt > best.updatedAt) best = c;
    }
    // Only adopt hydrated tokens if a live connect hasn't primed newer ones.
    if (best && e.tokens === undefined) e.tokens = best.tokens;
  })();
  return e.hydration;
}

/**
 * Resolve a usable bearer for the provider, refreshing (and persisting the
 * rotation) when the access token is expired. Throws
 * {@link OAuthReconnectRequiredError} when the stored grant is dead and
 * a plain Error when no tokens are stored at all.
 */
export async function getProviderOAuthBearer(
  providerId: string,
  deps: ProviderOAuthDeps = {},
): Promise<string> {
  const e = entry(providerId);
  if (e.state === 'reconnect_required') {
    throw new OAuthReconnectRequiredError('cached');
  }
  await hydrate(providerId, e);
  const nowMs = deps.nowMs ?? Date.now;
  if (e.tokens && !isAccessTokenExpired(e.tokens, nowMs())) {
    return e.tokens.accessToken;
  }
  if (e.inflight) return e.inflight;

  const config = deps.config ?? OPENAI_CODEX_OAUTH;
  const fetchImpl =
    deps.fetchImpl ??
    (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (fetchImpl === undefined) {
    throw new Error('oauth: no fetch implementation available');
  }

  e.inflight = (async () => {
    try {
      const current = e.tokens;
      if (current?.refreshToken === undefined) {
        // No refresh path: hand out what we have (a 401 will surface truth),
        // or fail clearly when nothing is stored.
        if (current) return current.accessToken;
        throw new Error(
          `oauth: no tokens stored for provider "${providerId}" — connect it first`,
        );
      }
      const refreshed = await refreshAccessToken(
        fetchImpl,
        config,
        current.refreshToken,
        nowMs,
      );
      // Memory is canonical (this store's whole design). Commit the rotation to
      // memory FIRST — the old refresh token is already dead server-side, so the
      // refreshed one must never be dropped. Then persist; a persist failure is
      // degraded to a warning (worst case: lost on restart, recovered by a
      // re-connect) rather than throwing away a live token and wedging the grant.
      e.tokens = refreshed;
      try {
        await bindings.get(providerId)?.persist(refreshed, nowMs());
      } catch (persistErr) {
        (deps.log ?? (() => undefined))(
          `oauth: failed to persist rotated tokens for "${providerId}" (kept in memory):`,
          persistErr,
        );
      }
      return refreshed.accessToken;
    } catch (err) {
      if (err instanceof OAuthReconnectRequiredError) {
        e.state = 'reconnect_required';
        e.tokens = undefined;
      }
      throw err;
    } finally {
      e.inflight = undefined;
    }
  })();
  return e.inflight;
}

/** Test seam: drop all in-memory state and bindings. */
export function __resetProviderOAuthTokenStore(): void {
  entries.clear();
  bindings.clear();
}
