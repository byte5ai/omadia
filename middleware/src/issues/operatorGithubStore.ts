/**
 * Per-operator GitHub-connection store, backed by the SecretVault.
 *
 * The operator's GitHub OAuth access token is a server-only secret: it is
 * written here keyed by the operator's session `sub` and is NEVER returned
 * to the browser. The web-ui only ever learns `{ connected, login }`.
 *
 * Vault namespacing: the vault isolates by `agentId`; we use a single
 * fixed namespace and prefix every key with the operator `sub` so two
 * operators on the same instance never read each other's tokens.
 */

import type { SecretVault } from '../secrets/vault.js';

export const GITHUB_CONNECT_AGENT_ID = 'core:github-connect';

const FIELD_ACCESS_TOKEN = 'access_token';
const FIELD_LOGIN = 'login';
const FIELD_SCOPE = 'scope';

function vaultKey(sub: string, field: string): string {
  return `${sub}/${field}`;
}

export interface GithubConnection {
  connected: boolean;
  login?: string;
  scope?: string;
}

export async function getConnection(
  vault: SecretVault,
  sub: string,
): Promise<GithubConnection> {
  const token = await vault.get(
    GITHUB_CONNECT_AGENT_ID,
    vaultKey(sub, FIELD_ACCESS_TOKEN),
  );
  if (!token) return { connected: false };
  const login = await vault.get(
    GITHUB_CONNECT_AGENT_ID,
    vaultKey(sub, FIELD_LOGIN),
  );
  const scope = await vault.get(
    GITHUB_CONNECT_AGENT_ID,
    vaultKey(sub, FIELD_SCOPE),
  );
  return {
    connected: true,
    login: login || undefined,
    scope: scope || undefined,
  };
}

export async function getToken(
  vault: SecretVault,
  sub: string,
): Promise<string | undefined> {
  return vault.get(GITHUB_CONNECT_AGENT_ID, vaultKey(sub, FIELD_ACCESS_TOKEN));
}

export async function saveConnection(
  vault: SecretVault,
  sub: string,
  input: { accessToken: string; login: string; scope: string },
): Promise<void> {
  await vault.set(
    GITHUB_CONNECT_AGENT_ID,
    vaultKey(sub, FIELD_ACCESS_TOKEN),
    input.accessToken,
  );
  await vault.set(GITHUB_CONNECT_AGENT_ID, vaultKey(sub, FIELD_LOGIN), input.login);
  await vault.set(GITHUB_CONNECT_AGENT_ID, vaultKey(sub, FIELD_SCOPE), input.scope);
}

export async function clearConnection(
  vault: SecretVault,
  sub: string,
): Promise<void> {
  await vault.deleteKey(
    GITHUB_CONNECT_AGENT_ID,
    vaultKey(sub, FIELD_ACCESS_TOKEN),
  );
  await vault.deleteKey(GITHUB_CONNECT_AGENT_ID, vaultKey(sub, FIELD_LOGIN));
  await vault.deleteKey(GITHUB_CONNECT_AGENT_ID, vaultKey(sub, FIELD_SCOPE));
}
