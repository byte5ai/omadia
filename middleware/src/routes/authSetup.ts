import { providerApiKeyVaultKey } from '@omadia/llm-provider';
import type { Request, RequestHandler, Response } from 'express';

import { credentialEpoch } from '../auth/loginDevices.js';
import type { LoginRateLimiter } from '../auth/loginRateLimiter.js';
import { hashPassword } from '../auth/passwordHasher.js';
import { LOCAL_PROVIDER_ID } from '../auth/providers/LocalPasswordProvider.js';
import type { ProviderRegistry } from '../auth/providerRegistry.js';
import { setupTokenMatches } from '../auth/setupToken.js';
import {
  isLockTimeout,
  type FirstAdminResult,
  type UserRecord,
  type UserStore,
} from '../auth/userStore.js';
import {
  encodeVerifiedRecord,
  keyFingerprint,
  providerVerifiedAtVaultKey,
  verifyProviderCredential,
} from '../platform/providerCredentialVerifier.js';
import type { SecretVault } from '../secrets/vault.js';

/**
 * `POST /api/v1/auth/setup` — the one-shot first-user wizard — and the
 * predicate `GET /api/v1/auth/providers` reports as `setup_required`.
 *
 * The route sits under the public `/api/v1/auth/*` prefix because there is no
 * operator yet. It authorises itself, in this order:
 *
 *   1. the operator's setup token (when this boot has one) — BEFORE anything
 *      else, so a caller the operator never authorised cannot make the server
 *      validate a body, run argon2, or wait on the `users` table lock;
 *   2. `resolveSetupState` — the SAME predicate `/providers` answers from, so
 *      discovery and handler can no longer disagree;
 *   3. `UserStore.createFirstAdmin` — the emptiness check and the INSERT as
 *      one transaction under a table lock, so concurrent requests produce
 *      exactly one admin.
 */

/** Why the wizard is, or is not, open right now. */
export type SetupState = 'available' | 'disabled_at_boot' | 'no_local_provider' | 'locked';

export interface SetupStateDeps {
  /** Boot-time verdict of `runAuthBootstrap`: the users table was empty and
   *  no env seed ran. The wizard never opens on a boot where this is false —
   *  a table emptied later needs a restart to reopen it. */
  setupAllowed: boolean;
  registry: Pick<ProviderRegistry, 'get'>;
  userStore: Pick<UserStore, 'count'>;
}

/**
 * The single predicate behind `/providers.setup_required` and the `/setup`
 * handler's fast path.
 *
 * The COUNT runs before the boot flag is read. While users exist the answer is
 * `locked` ("setup already completed") whatever this boot decided, so an
 * install that is already set up keeps answering the way it always did: to a
 * provisioning script, to a replica that started after setup finished, and to
 * the wizard, which sends the browser to /login on that code.
 * `disabled_at_boot` is left for the one case a restart changes: the table is
 * empty now but was not when this process started (only direct SQL gets
 * there, since an admin cannot delete themselves).
 */
export async function resolveSetupState(deps: SetupStateDeps): Promise<SetupState> {
  if (!deps.registry.get(LOCAL_PROVIDER_ID)) return 'no_local_provider';
  if ((await deps.userStore.count()) > 0) return 'locked';
  if (!deps.setupAllowed) return 'disabled_at_boot';
  return 'available';
}

export interface SetupRouteDeps extends SetupStateDeps {
  userStore: Pick<UserStore, 'count' | 'createFirstAdmin' | 'markLoginNow'>;
  /** The sign-in limiter's global argon2 capacity (§10m). The wizard's hash
   *  takes a slot like a login does, so parallel setup requests cannot run
   *  more argon2 at once than `AUTH_LOGIN_MAX_INFLIGHT` allows. */
  loginCapacity: Pick<LoginRateLimiter, 'acquireSlot'>;
  /** Operator setup token; undefined = this boot has no token gate (desktop
   *  kernel on loopback, or no wizard at all). */
  setupToken?: string;
  /** OB-61 back-compat: seed an `anthropic_api_key` the caller supplied. */
  vault?: SecretVault;
  reactivate?: (agentId: string) => Promise<void>;
  anthropicKeyConsumers?: readonly string[];
  /** Mints the session cookie for the admin just created (the auth router
   *  owns session minting), and its device cookie under `epoch`: the
   *  credential epoch of the row and hash this request wrote (§10m). */
  signIn: (req: Request, res: Response, user: UserRecord, epoch: string) => Promise<void>;
  log?: (msg: string) => void;
}

interface SetupBody {
  setupToken: unknown;
  email: string;
  password: string;
  displayName: string;
  anthropicApiKey: string;
}

function readSetupBody(req: Request): SetupBody {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    setupToken: body['setup_token'],
    email: str(body['email']).trim(),
    password: str(body['password']),
    displayName: str(body['display_name']).trim(),
    anthropicApiKey: str(body['anthropic_api_key']).trim(),
  };
}

/** A saturated argon2 capacity frees a slot within the time of one hash. */
const BUSY_RETRY_AFTER_S = 1;

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

const STATE_REFUSALS: Record<Exclude<SetupState, 'available'>, { code: string; message: string }> = {
  disabled_at_boot: {
    code: 'auth.setup_disabled',
    message:
      'setup is not available on this server start — the users table was emptied after the middleware started; restart the middleware to reopen the wizard',
  },
  no_local_provider: {
    code: 'auth.setup_no_local_provider',
    message:
      'setup wizard requires the "local" auth provider to be active in AUTH_PROVIDERS',
  },
  locked: { code: 'auth.setup_locked', message: 'setup already completed' },
};

function refuseState(res: Response, state: Exclude<SetupState, 'available'>): void {
  const { code, message } = STATE_REFUSALS[state];
  refuse(res, 410, code, message);
}

/**
 * OB-61: validate an operator-supplied Anthropic key before any state is
 * persisted. Returns the verification timestamp for an accepted key (or
 * undefined when the ping was inconclusive), or `false` after it has answered
 * the request with a 400. The wizard UI stopped sending a key in S4; the
 * endpoint keeps accepting one for back-compat (#1090).
 */
async function checkAnthropicKey(
  res: Response,
  apiKey: string,
  log: (msg: string) => void,
): Promise<string | undefined | false> {
  if (!apiKey.startsWith('sk-ant-')) {
    refuse(
      res,
      400,
      'auth.setup_invalid_anthropic_key',
      'Anthropic API keys start with "sk-ant-". Double-check the value from console.anthropic.com.',
    );
    return false;
  }
  // Only an outright rejection blocks setup — a 5xx, a rate-limit or an
  // offline machine still lets the operator through (OM-08: the ping's
  // result is recorded with the key).
  const verification = await verifyProviderCredential({
    providerId: 'anthropic',
    apiKey,
    wireFormat: 'anthropic',
    force: true,
  });
  if (verification.status === 'invalid') {
    refuse(
      res,
      400,
      'auth.setup_anthropic_key_rejected',
      verification.error ??
        'Anthropic rejected this API key (401/403). Verify the value at console.anthropic.com → API keys.',
    );
    return false;
  }
  if (verification.status !== 'verified') {
    log('[auth] /setup: anthropic key-ping inconclusive, accepting key anyway');
  }
  return verification.verifiedAt;
}

/**
 * OB-61: seed the validated key into every consumer plugin's vault and
 * reactivate each. A failure is logged but never rolls back the admin — the
 * operator must be able to sign in and re-seed on the LLM access page.
 */
async function seedAnthropicKey(
  deps: SetupRouteDeps,
  apiKey: string,
  verifiedAt: string | undefined,
): Promise<void> {
  if (!deps.vault) return;
  for (const agentId of deps.anthropicKeyConsumers ?? []) {
    try {
      await deps.vault.setMany(agentId, {
        [providerApiKeyVaultKey('anthropic')]: apiKey,
        ...(verifiedAt !== undefined
          ? {
              [providerVerifiedAtVaultKey('anthropic')]: encodeVerifiedRecord(
                verifiedAt,
                keyFingerprint(apiKey),
              ),
            }
          : {}),
      });
      if (deps.reactivate) await deps.reactivate(agentId);
    } catch (err) {
      console.error(
        `[auth] /setup: failed to seed anthropic_api_key for ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function createSetupHandler(deps: SetupRouteDeps): RequestHandler {
  const log = deps.log ?? ((m: string) => console.warn(m));

  return async (req: Request, res: Response) => {
    const body = readSetupBody(req);

    // 1. Operator authorisation. The body field is the only transport; a
    //    header copy would be a second spelling of the same credential with
    //    no caller that needs it.
    if (deps.setupToken !== undefined && !setupTokenMatches(deps.setupToken, body.setupToken)) {
      log(
        `[auth] /setup refused: missing or wrong setup token (peer ${req.socket.remoteAddress ?? 'unknown'})`,
      );
      refuse(
        res,
        403,
        'auth.setup_token_invalid',
        'a valid setup token is required — the middleware prints it to its log at start, or it is the value of ADMIN_SETUP_TOKEN',
      );
      return;
    }

    // 2. Fast path — the same predicate /providers reports.
    const state = await resolveSetupState(deps);
    if (state !== 'available') {
      refuseState(res, state);
      return;
    }

    if (body.email.length === 0 || !body.email.includes('@')) {
      res.status(400).json({ code: 'auth.setup_invalid_email' });
      return;
    }
    if (body.password.length < 8) {
      res.status(400).json({ code: 'auth.setup_password_too_short' });
      return;
    }

    let anthropicVerifiedAt: string | undefined;
    if (body.anthropicApiKey.length > 0) {
      const checked = await checkAnthropicKey(res, body.anthropicApiKey, log);
      if (checked === false) return;
      anthropicVerifiedAt = checked;
    }

    // Hash OUTSIDE the lock: argon2 takes tens of milliseconds, the locked
    // section only a few. The hash holds a slot of the sign-in limiter's
    // global capacity, released whatever the hash does.
    const release = deps.loginCapacity.acquireSlot();
    if (!release) {
      res.set('Retry-After', String(BUSY_RETRY_AFTER_S));
      res.status(503).json({
        code: 'auth.busy',
        retry_after_s: BUSY_RETRY_AFTER_S,
        message: 'the server is busy verifying other sign-ins — try again in a moment',
      });
      return;
    }
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(body.password);
    } finally {
      release();
    }

    // 3. The atomic create.
    let result: FirstAdminResult;
    try {
      result = await deps.userStore.createFirstAdmin({
        email: body.email,
        provider: LOCAL_PROVIDER_ID,
        providerUserId: body.email.toLowerCase(),
        passwordHash,
        displayName: body.displayName.length > 0 ? body.displayName : body.email,
        via: 'setup_wizard',
      });
    } catch (err) {
      if (isLockTimeout(err)) {
        refuse(
          res,
          409,
          'auth.setup_in_progress',
          'another setup request is being processed — try again in a moment',
        );
        return;
      }
      throw err;
    }
    if (result.outcome === 'not_empty') {
      // Another request (or an OIDC first sign-in) committed first.
      refuseState(res, 'locked');
      return;
    }
    const user = result.user;

    if (body.anthropicApiKey.length > 0) {
      await seedAnthropicKey(deps, body.anthropicApiKey, anthropicVerifiedAt);
    }

    // Auto-login the freshly-created admin so the operator lands inside the
    // UI without a second round-trip. Its device cookie is bound to the
    // password this request set, never to one read back later.
    await deps.signIn(req, res, user, credentialEpoch({ id: user.id, passwordHash }));
    void deps.userStore.markLoginNow(user.id).catch(() => undefined);

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        role: user.role,
        provider: user.provider,
      },
    });
  };
}
