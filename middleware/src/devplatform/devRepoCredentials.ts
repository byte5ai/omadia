/**
 * Epic #470 W0 — per-repo credential storage for the dev platform, backed by
 * the SecretVault.
 *
 * A registered repo's git/API token (device-flow OAuth token or PAT) is a
 * server-only secret. It is written here and NEVER returned to the browser:
 * the web-ui only ever learns `{ connected, login }` via `getConnection`.
 *
 * Vault namespacing follows `src/issues/operatorGithubStore.ts`: the vault
 * isolates by `agentId`, so we use one fixed namespace (`core:dev-platform`)
 * and prefix every key. `dev_repos.credential_ref` is `repo/<repoId>`, so W2's
 * GitHub-App mode swaps `credential_kind` + ref without touching job code.
 *
 * A device-flow token is minted before the `dev_repos` row exists (the operator
 * authorizes, then names the repo), so it is parked under `pending/<sub>/token`
 * and moved onto the repo row by `promotePending` once the row is created.
 */

import type { SecretVault } from '../secrets/vault.js';

/** Fixed vault namespace for all dev-platform repo credentials. */
export const DEV_PLATFORM_AGENT_ID = 'core:dev-platform';

/**
 * The credential kinds that carry a bearer token in W0. A subset of
 * `DevRepoCredentialKind` in types.ts — `github_app` (W2) and `deploy_key`
 * do not store a raw token under these keys.
 */
export type DevRepoTokenKind = 'device_flow' | 'pat';

/** Browser-safe connection view. Deliberately carries no token. */
export interface DevRepoConnection {
  connected: boolean;
  login?: string;
  kind?: DevRepoTokenKind;
}

export interface SaveDevRepoCredentialInput {
  token: string;
  kind: DevRepoTokenKind;
  login?: string;
}

function repoTokenKey(repoId: string): string {
  return `repo/${repoId}/token`;
}
function repoTokenKindKey(repoId: string): string {
  return `repo/${repoId}/token_kind`;
}
function repoLoginKey(repoId: string): string {
  return `repo/${repoId}/login`;
}
function pendingTokenKey(sub: string): string {
  return `pending/${sub}/token`;
}

function asTokenKind(raw: string | undefined): DevRepoTokenKind | undefined {
  return raw === 'device_flow' || raw === 'pat' ? raw : undefined;
}

export class DevRepoCredentialStore {
  constructor(private readonly vault: SecretVault) {}

  /**
   * Browser-facing status. Returns `{ connected, login, kind }` — never the
   * token. The token is intentionally absent from this shape so it cannot
   * leak into an HTTP response by accident.
   */
  async getConnection(repoId: string): Promise<DevRepoConnection> {
    const token = await this.vault.get(DEV_PLATFORM_AGENT_ID, repoTokenKey(repoId));
    if (!token) return { connected: false };
    const login = await this.vault.get(DEV_PLATFORM_AGENT_ID, repoLoginKey(repoId));
    const kind = await this.vault.get(DEV_PLATFORM_AGENT_ID, repoTokenKindKey(repoId));
    return {
      connected: true,
      login: login || undefined,
      kind: asTokenKind(kind),
    };
  }

  /** Write (or overwrite) a repo's credential. `login` is optional. */
  async save(repoId: string, input: SaveDevRepoCredentialInput): Promise<void> {
    await this.vault.set(DEV_PLATFORM_AGENT_ID, repoTokenKey(repoId), input.token);
    await this.vault.set(
      DEV_PLATFORM_AGENT_ID,
      repoTokenKindKey(repoId),
      input.kind,
    );
    if (input.login) {
      await this.vault.set(
        DEV_PLATFORM_AGENT_ID,
        repoLoginKey(repoId),
        input.login,
      );
    }
  }

  /**
   * The token for git/API use. Server-side only — a caller that puts this on
   * the wire, or in a log line, has broken the credential-isolation contract.
   */
  async resolve(repoId: string): Promise<string | undefined> {
    return this.vault.get(DEV_PLATFORM_AGENT_ID, repoTokenKey(repoId));
  }

  async getKind(repoId: string): Promise<DevRepoTokenKind | undefined> {
    return asTokenKind(
      await this.vault.get(DEV_PLATFORM_AGENT_ID, repoTokenKindKey(repoId)),
    );
  }

  /** Purge all three per-repo keys. Backs `deleteRepo` in the routes unit. */
  async clear(repoId: string): Promise<void> {
    await this.vault.deleteKey(DEV_PLATFORM_AGENT_ID, repoTokenKey(repoId));
    await this.vault.deleteKey(DEV_PLATFORM_AGENT_ID, repoTokenKindKey(repoId));
    await this.vault.deleteKey(DEV_PLATFORM_AGENT_ID, repoLoginKey(repoId));
  }

  /** Park a device-flow token before the `dev_repos` row exists (spec §6). */
  async stashPending(sub: string, token: string): Promise<void> {
    await this.vault.set(DEV_PLATFORM_AGENT_ID, pendingTokenKey(sub), token);
  }

  async resolvePending(sub: string): Promise<string | undefined> {
    return this.vault.get(DEV_PLATFORM_AGENT_ID, pendingTokenKey(sub));
  }

  async clearPending(sub: string): Promise<void> {
    await this.vault.deleteKey(DEV_PLATFORM_AGENT_ID, pendingTokenKey(sub));
  }

  /**
   * Move a parked device-flow token onto a freshly-created repo row and drop
   * the staging key. `login` is captured during the POST /repos access probe.
   * Returns `false` when nothing was parked for `sub`.
   */
  async promotePending(
    sub: string,
    repoId: string,
    login?: string,
  ): Promise<boolean> {
    const token = await this.vault.get(
      DEV_PLATFORM_AGENT_ID,
      pendingTokenKey(sub),
    );
    if (!token) return false;
    await this.save(repoId, { token, kind: 'device_flow', login });
    await this.vault.deleteKey(DEV_PLATFORM_AGENT_ID, pendingTokenKey(sub));
    return true;
  }
}
