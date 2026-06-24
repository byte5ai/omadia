/**
 * Spec 005 — shared resolution of a plugin's OAuth descriptor + client
 * credentials. One source of truth for the security-critical lookup, used by
 * BOTH the broker (start/callback) and the `ctx.oauthTokens` accessor so the
 * two can never drift on where client_id/client_secret come from.
 *
 * client_id is read from the plugin's stored config; client_secret from its
 * vault namespace (declared as a `secret` setup field). Both are scoped to the
 * one plugin — there is no `depends_on` inheritance here.
 */

import type { OAuthProviderDescriptor, Plugin } from '../../api/admin-v1.js';
import type { SecretVault } from '../../secrets/vault.js';

export class OAuthBrokerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'OAuthBrokerError';
  }
}

export interface ResolvedOAuthProvider {
  descriptor: OAuthProviderDescriptor;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** String-only config entries, for `{field}` URL interpolation. */
  configValues: Record<string, string>;
}

export async function resolveOAuthProvider(args: {
  plugin: Plugin;
  pluginId: string;
  fieldKey: string;
  config: Record<string, unknown>;
  vault: SecretVault;
}): Promise<ResolvedOAuthProvider> {
  const { plugin, pluginId, fieldKey, config, vault } = args;

  const field = plugin.setup_fields.find(
    (f) => f.key === fieldKey && f.type === 'oauth',
  );
  if (!field || !field.provider) {
    throw new OAuthBrokerError(
      'oauth.field_not_found',
      `plugin '${pluginId}' has no oauth field '${fieldKey}' with a provider`,
      404,
    );
  }
  const descriptor = plugin.oauth_providers?.find(
    (d) => d.id === field.provider,
  );
  if (!descriptor) {
    throw new OAuthBrokerError(
      'oauth.descriptor_not_found',
      `plugin '${pluginId}' declares no oauth_providers descriptor '${field.provider}'`,
      404,
    );
  }

  const configValues = stringValues(config);
  const clientId = configValues[descriptor.client_id_field] ?? '';
  if (!clientId) {
    throw new OAuthBrokerError(
      'oauth.client_id_missing',
      `plugin '${pluginId}' has no '${descriptor.client_id_field}' configured`,
      409,
    );
  }

  const clientSecret =
    (await vault.get(pluginId, descriptor.client_secret_field)) ?? '';
  if (!clientSecret) {
    throw new OAuthBrokerError(
      'oauth.client_secret_missing',
      `plugin '${pluginId}' has no '${descriptor.client_secret_field}' secret configured`,
      409,
    );
  }

  return {
    descriptor,
    clientId,
    clientSecret,
    scopes: field.scopes ?? [],
    configValues,
  };
}

function stringValues(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
