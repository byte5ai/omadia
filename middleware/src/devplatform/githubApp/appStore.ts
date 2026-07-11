import type { Pool } from 'pg';

import { DEV_PLATFORM_AGENT_ID } from '../devRepoCredentials.js';
import type { SecretVault } from '../../secrets/vault.js';
import type { AppConversion } from './manifestFlow.js';

/**
 * Epic #470 W2 — the GitHub App registry: metadata in Postgres, secrets in Vault.
 *
 * The split is the whole point. `dev_github_apps` and `dev_github_app_installations`
 * hold only non-secret metadata (app id, slug, owner, urls); the PEM, webhook
 * secret, and client credentials live in Vault under the `core:dev-platform`
 * namespace with `github-app/<app_id>/` keys — the same namespacing
 * `DevRepoCredentialStore` uses. No secret ever touches a column, a log line, or
 * an API response.
 */

const secretKey = (appId: string, name: string): string => `github-app/${appId}/${name}`;

export interface DevGithubApp {
  id: string;
  appId: string;
  slug: string;
  ownerLogin: string;
  htmlUrl: string;
  apiBaseUrl: string;
  createdBy: string;
}

export interface DevGithubAppInstallation {
  id: string;
  appRowId: string;
  installationId: string;
  accountLogin: string;
}

/** The secret material a mint needs — read from Vault, never persisted elsewhere. */
export interface DevGithubAppSecrets {
  privateKey: string;
  webhookSecret?: string;
  clientId?: string;
  clientSecret?: string;
}

interface AppRow {
  id: string;
  app_id: string;
  slug: string;
  owner_login: string;
  html_url: string;
  api_base_url: string;
  created_by: string;
}

interface InstallationRow {
  id: string;
  app_row_id: string;
  installation_id: string;
  account_login: string;
}

function toApp(r: AppRow): DevGithubApp {
  return {
    id: r.id,
    appId: r.app_id,
    slug: r.slug,
    ownerLogin: r.owner_login,
    htmlUrl: r.html_url,
    apiBaseUrl: r.api_base_url,
    createdBy: r.created_by,
  };
}

export class DevGithubAppStore {
  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
  ) {}

  /**
   * Persist a converted App: the row first, then the secrets. If the Vault write
   * fails, the row is rolled back so we never keep a metadata row we cannot
   * authenticate — the operator is told to delete the orphan App on GitHub and
   * re-run, rather than being left with a half-registered App.
   */
  async saveApp(conv: AppConversion, apiBaseUrl: string, createdBy: string): Promise<DevGithubApp> {
    const client = await this.pool.connect();
    const secretNames = ['private_key', 'webhook_secret', 'client_id', 'client_secret'] as const;
    let vaultWritten = false;
    try {
      await client.query('BEGIN');
      const r = await client.query<AppRow>(
        `INSERT INTO dev_github_apps (app_id, slug, owner_login, html_url, api_base_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (app_id) DO UPDATE
           SET slug = EXCLUDED.slug, owner_login = EXCLUDED.owner_login,
               html_url = EXCLUDED.html_url, api_base_url = EXCLUDED.api_base_url
         RETURNING id, app_id, slug, owner_login, html_url, api_base_url, created_by`,
        [String(conv.id), conv.slug, conv.ownerLogin, conv.htmlUrl, apiBaseUrl, createdBy],
      );
      // Secrets go to Vault, keyed by the GitHub app id (stable across re-runs).
      await this.vault.setMany(DEV_PLATFORM_AGENT_ID, {
        [secretKey(String(conv.id), 'private_key')]: conv.pem,
        [secretKey(String(conv.id), 'webhook_secret')]: conv.webhookSecret,
        [secretKey(String(conv.id), 'client_id')]: conv.clientId,
        [secretKey(String(conv.id), 'client_secret')]: conv.clientSecret,
      });
      vaultWritten = true;
      await client.query('COMMIT');
      return toApp(r.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // A COMMIT that fails AFTER the Vault write rolls back the row but leaves the
      // secrets — the mirror of the half-registered App the row-first order avoids
      // (Forge #5). Best-effort remove them so no orphan secret survives. Keyed by
      // the stable app_id, so a re-run overwrites them anyway; this just keeps the
      // failed attempt from leaving credential material behind.
      if (vaultWritten) {
        await Promise.all(
          secretNames.map((n) =>
            this.vault.deleteKey(DEV_PLATFORM_AGENT_ID, secretKey(String(conv.id), n)).catch(() => {}),
          ),
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** List apps with installation counts. NEVER returns secret material. */
  async listApps(): Promise<Array<DevGithubApp & { installations: number }>> {
    const r = await this.pool.query<AppRow & { installations: string }>(
      `SELECT a.id, a.app_id, a.slug, a.owner_login, a.html_url, a.api_base_url, a.created_by,
              COUNT(i.id)::text AS installations
         FROM dev_github_apps a
         LEFT JOIN dev_github_app_installations i ON i.app_row_id = a.id
        GROUP BY a.id
        ORDER BY a.created_at DESC`,
    );
    return r.rows.map((row) => ({ ...toApp(row), installations: Number(row.installations) }));
  }

  async getApp(appRowId: string): Promise<DevGithubApp | null> {
    const r = await this.pool.query<AppRow>(
      `SELECT id, app_id, slug, owner_login, html_url, api_base_url, created_by
         FROM dev_github_apps WHERE id = $1`,
      [appRowId],
    );
    return r.rows[0] ? toApp(r.rows[0]) : null;
  }

  async getAppByGithubId(appId: string): Promise<DevGithubApp | null> {
    const r = await this.pool.query<AppRow>(
      `SELECT id, app_id, slug, owner_login, html_url, api_base_url, created_by
         FROM dev_github_apps WHERE app_id = $1`,
      [appId],
    );
    return r.rows[0] ? toApp(r.rows[0]) : null;
  }

  /** Read the secret material for a mint. Absent private key ⇒ the App is unusable. */
  async getSecrets(appId: string): Promise<DevGithubAppSecrets | null> {
    const privateKey = await this.vault.get(DEV_PLATFORM_AGENT_ID, secretKey(appId, 'private_key'));
    if (!privateKey) return null;
    return {
      privateKey,
      webhookSecret: await this.vault.get(DEV_PLATFORM_AGENT_ID, secretKey(appId, 'webhook_secret')),
      clientId: await this.vault.get(DEV_PLATFORM_AGENT_ID, secretKey(appId, 'client_id')),
      clientSecret: await this.vault.get(DEV_PLATFORM_AGENT_ID, secretKey(appId, 'client_secret')),
    };
  }

  async upsertInstallation(
    appRowId: string,
    installationId: string,
    accountLogin: string,
  ): Promise<DevGithubAppInstallation> {
    const r = await this.pool.query<InstallationRow>(
      `INSERT INTO dev_github_app_installations (app_row_id, installation_id, account_login)
       VALUES ($1,$2,$3)
       ON CONFLICT (app_row_id, installation_id) DO UPDATE SET account_login = EXCLUDED.account_login
       RETURNING id, app_row_id, installation_id, account_login`,
      [appRowId, installationId, accountLogin],
    );
    const row = r.rows[0]!;
    return {
      id: row.id,
      appRowId: row.app_row_id,
      installationId: row.installation_id,
      accountLogin: row.account_login,
    };
  }

  /** Find the App a raw installation id belongs to (for the setup callback). */
  async findInstallation(installationId: string): Promise<DevGithubAppInstallation | null> {
    const r = await this.pool.query<InstallationRow>(
      `SELECT id, app_row_id, installation_id, account_login
         FROM dev_github_app_installations WHERE installation_id = $1`,
      [installationId],
    );
    const row = r.rows[0];
    return row
      ? { id: row.id, appRowId: row.app_row_id, installationId: row.installation_id, accountLogin: row.account_login }
      : null;
  }
}
