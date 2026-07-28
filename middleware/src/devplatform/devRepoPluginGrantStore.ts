/**
 * Epic #470 W3 — operator grants that gate `ctx.devJobs` (spec §2).
 *
 * A row in `dev_repo_plugin_grants` (migration 0024) means "the operator has
 * allowed plugin P to drive dev jobs on repo R". The `ctx.devJobs` accessor
 * resolves ONLY the repos a plugin is granted; everything else fails closed.
 * Granting/revoking is always an explicit operator action (the admin
 * `/admin/dev-platform` surface, wired in a sibling W3 unit) — never something
 * a plugin can do to itself.
 */

import type { Pool } from 'pg';

import { iso, str, type Row } from './pgMappers.js';

export interface DevRepoPluginGrant {
  readonly repoId: string;
  readonly pluginId: string;
  readonly grantedBy: string;
  readonly createdAt: string;
}

function toGrant(r: Row): DevRepoPluginGrant {
  return {
    repoId: str(r['repo_id']),
    pluginId: str(r['plugin_id']),
    grantedBy: str(r['granted_by']),
    createdAt: iso(r['created_at']),
  };
}

export class DevRepoPluginGrantStore {
  constructor(private readonly pool: Pool) {}

  /** Repo ids granted to a plugin — the fail-closed set the accessor scopes to. */
  async listRepoIdsForPlugin(pluginId: string): Promise<string[]> {
    const r = await this.pool.query<Row>(
      `SELECT repo_id FROM dev_repo_plugin_grants WHERE plugin_id = $1
       ORDER BY created_at ASC`,
      [pluginId],
    );
    return r.rows.map((row) => str(row['repo_id']));
  }

  /** Plugin ids granted on a repo — for the operator grant UI. */
  async listGrantsForRepo(repoId: string): Promise<DevRepoPluginGrant[]> {
    const r = await this.pool.query<Row>(
      `SELECT repo_id, plugin_id, granted_by, created_at
         FROM dev_repo_plugin_grants WHERE repo_id = $1 ORDER BY created_at ASC`,
      [repoId],
    );
    return r.rows.map(toGrant);
  }

  async isGranted(repoId: string, pluginId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM dev_repo_plugin_grants WHERE repo_id = $1 AND plugin_id = $2`,
      [repoId, pluginId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Idempotent grant (UNIQUE(repo_id, plugin_id) — a repeat is a no-op). */
  async grant(repoId: string, pluginId: string, grantedBy: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO dev_repo_plugin_grants (repo_id, plugin_id, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (repo_id, plugin_id) DO NOTHING`,
      [repoId, pluginId, grantedBy],
    );
  }

  async revoke(repoId: string, pluginId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM dev_repo_plugin_grants WHERE repo_id = $1 AND plugin_id = $2`,
      [repoId, pluginId],
    );
  }
}
