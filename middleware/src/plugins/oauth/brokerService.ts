/**
 * Spec 005 — kernel OAuth broker service (the logic behind
 * `/api/v1/install/oauth/start` + `/callback`).
 *
 * Standard authorization-code flow, kernel-owned end to end: the operator
 * clicks Connect, the broker resolves the plugin's declarative descriptor +
 * its stored client credentials, signs a single-use plugin-bound state, and
 * redirects to the IdP. On callback it verifies state, consumes the pending
 * flow, runs the generic engine's code exchange, and persists the tokens to
 * the plugin's own vault namespace. No plugin code runs in the loop, so the
 * client secret and refresh token never leave the kernel.
 *
 * Two entry shapes (FR-G1): the install-drawer path carries a `jobId`; the
 * store-detail re-connect path carries only a `pluginId`. Both resolve the
 * provider by `pluginId` — the route maps `jobId → pluginId` before calling
 * `start`. v1 connects the `type:oauth` field post-install (the field is
 * `install_hidden`); the `jobId` is carried for forward-compat but the broker
 * does not gate `configure()` on it.
 */

import type { SecretVault } from '../../secrets/vault.js';
import type { InstalledRegistry } from '../installedRegistry.js';
import type { PluginCatalog } from '../manifestLoader.js';

import { buildAuthorizeUrl, exchangeCode } from './engine.js';
import { generateCodeVerifier, computeCodeChallenge } from './pkce.js';
import type { PendingFlowStore } from './pendingFlows.js';
import {
  OAuthBrokerError,
  resolveOAuthProvider,
  type ResolvedOAuthProvider,
} from './providerResolve.js';
import { signOAuthState, verifyOAuthState } from './state.js';
import { writeStoredTokens } from './tokenStore.js';

export { OAuthBrokerError } from './providerResolve.js';

export interface OAuthBrokerDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  vault: SecretVault;
  pendingFlows: PendingFlowStore;
  /** Kernel-held HS512 key — also signs sessions; never exposed to plugins. */
  signingKey: Uint8Array;
  /** Operator-facing origin. The callback redirect_uri is
   *  `${publicBaseUrl}/bot-api/v1/install/oauth/callback`; the post-callback
   *  redirect is `${publicBaseUrl}/store/<id>?connected=…`. */
  publicBaseUrl: string;
  /** Re-activate the plugin after a successful connect so it re-resolves its
   *  connection state (the plugin reads the freshly-stored token, resolves any
   *  derived config, and clears its `ctx.status`). Optional — without it the
   *  new tokens are stored but the plugin's status/derived-config only refresh
   *  on its next activation. Wired to `installService.reactivate`. */
  reactivatePlugin?: (pluginId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface StartInput {
  pluginId: string;
  fieldKey: string;
  /** Install-job id, when started from the drawer. Carried into state. */
  jobId?: string;
}

export interface CallbackInput {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

export class OAuthBrokerService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: OAuthBrokerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Build the IdP authorize redirect for a Connect click. Throws an
   *  {@link OAuthBrokerError} (mapped to an HTTP status by the route) when the
   *  plugin/field/descriptor/creds can't be resolved. */
  async start(input: StartInput): Promise<{ redirectUrl: string }> {
    const resolved = await this.resolveProvider(input.pluginId, input.fieldKey);
    const { descriptor } = resolved;

    let codeVerifier = '';
    let codeChallenge: string | undefined;
    if (descriptor.pkce) {
      codeVerifier = generateCodeVerifier();
      codeChallenge = await computeCodeChallenge(codeVerifier);
    }

    const flow = this.deps.pendingFlows.create({
      pluginId: input.pluginId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      fieldKey: input.fieldKey,
      providerId: descriptor.id,
      codeVerifier,
      scopes: resolved.scopes,
    });

    const state = await signOAuthState(
      {
        flowId: flow.flowId,
        pluginId: input.pluginId,
        providerId: descriptor.id,
        fieldKey: input.fieldKey,
        ...(input.jobId ? { jobId: input.jobId } : {}),
      },
      this.deps.signingKey,
    );

    const redirectUrl = buildAuthorizeUrl({
      descriptor,
      clientId: resolved.clientId,
      redirectUri: this.callbackUri(),
      scopes: resolved.scopes,
      state,
      codeChallenge,
      configValues: resolved.configValues,
    });
    return { redirectUrl };
  }

  /** Verify + consume a flow, exchange the code, persist tokens. Never throws
   *  to the route — every outcome is a redirect back to the store page with a
   *  `connected=ok|error` flag (FR-G2/G4). */
  async callback(input: CallbackInput): Promise<{ redirectUrl: string }> {
    if (!input.state) {
      return { redirectUrl: this.storeListUrl('error', 'missing_state') };
    }

    let claims;
    try {
      claims = await verifyOAuthState(input.state, this.deps.signingKey);
    } catch {
      return { redirectUrl: this.storeListUrl('error', 'bad_state') };
    }

    // Single-use: consume the pending flow up-front, whatever happens next.
    const flow = this.deps.pendingFlows.take(claims.flowId);
    const storeUrl = (status: 'ok' | 'error', reason?: string): string =>
      this.storeUrl(claims.pluginId, status, reason);

    if (!flow || flow.pluginId !== claims.pluginId) {
      return { redirectUrl: storeUrl('error', 'expired') };
    }
    if (input.error) {
      return { redirectUrl: storeUrl('error', sanitizeReason(input.error)) };
    }
    if (!input.code) {
      return { redirectUrl: storeUrl('error', 'no_code') };
    }

    let resolved: ResolvedOAuthProvider;
    try {
      resolved = await this.resolveProvider(claims.pluginId, claims.fieldKey);
    } catch {
      return { redirectUrl: storeUrl('error', 'not_configured') };
    }

    try {
      const tokens = await exchangeCode(
        {
          descriptor: resolved.descriptor,
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret,
          redirectUri: this.callbackUri(),
          code: input.code,
          ...(resolved.descriptor.pkce
            ? { codeVerifier: flow.codeVerifier }
            : {}),
          scopes: flow.scopes,
          configValues: resolved.configValues,
        },
        this.fetchImpl,
        this.now,
      );
      await writeStoredTokens(this.deps.vault, claims.pluginId, claims.fieldKey, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
      });
    } catch {
      return { redirectUrl: storeUrl('error', 'exchange_failed') };
    }

    // Re-activate so the plugin re-resolves its connection state with the
    // freshly-stored token (derived config + ctx.status). Best-effort — the
    // tokens are already persisted, so a hook failure must not fail the
    // connect; the plugin will pick them up on its next activation regardless.
    if (this.deps.reactivatePlugin) {
      try {
        await this.deps.reactivatePlugin(claims.pluginId);
      } catch (err) {
        console.error(
          `[oauth-broker] reactivate after connect failed for ${claims.pluginId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { redirectUrl: storeUrl('ok') };
  }

  /** Build an error redirect for the route layer (e.g. bad query params, or
   *  an {@link OAuthBrokerError} from `start`). Goes to the plugin's detail
   *  page when known, else the store list. */
  redirectForError(pluginId: string | undefined, reason: string): string {
    return pluginId
      ? this.storeUrl(pluginId, 'error', reason)
      : this.storeListUrl('error', reason);
  }

  // -- internals -----------------------------------------------------------

  private async resolveProvider(
    pluginId: string,
    fieldKey: string,
  ): Promise<ResolvedOAuthProvider> {
    const entry = this.deps.catalog.get(pluginId);
    if (!entry) {
      throw new OAuthBrokerError(
        'oauth.plugin_not_found',
        `no plugin '${pluginId}' in the catalog`,
        404,
      );
    }
    const config = this.deps.registry.get(pluginId)?.config ?? {};
    return await resolveOAuthProvider({
      plugin: entry.plugin,
      pluginId,
      fieldKey,
      config,
      vault: this.deps.vault,
    });
  }

  private callbackUri(): string {
    return `${trimSlash(this.deps.publicBaseUrl)}/bot-api/v1/install/oauth/callback`;
  }

  private storeUrl(pluginId: string, status: 'ok' | 'error', reason?: string): string {
    const base = `${trimSlash(this.deps.publicBaseUrl)}/store/${encodeURIComponent(pluginId)}`;
    const q = reason
      ? `?connected=${status}&reason=${encodeURIComponent(reason)}`
      : `?connected=${status}`;
    return base + q;
  }

  private storeListUrl(status: 'ok' | 'error', reason?: string): string {
    const base = `${trimSlash(this.deps.publicBaseUrl)}/store`;
    return reason
      ? `${base}?connected=${status}&reason=${encodeURIComponent(reason)}`
      : `${base}?connected=${status}`;
  }
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Keep an IdP-supplied error string short + log-safe in the redirect. */
function sanitizeReason(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'denied';
}
