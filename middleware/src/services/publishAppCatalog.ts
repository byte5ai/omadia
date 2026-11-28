/**
 * #2320 — the one read the publish admin view needs that `PublishStore`
 * (ADR-0067, insert-only by interface) deliberately does not offer: every app
 * with its live pointer and version count. Read-only SQL over
 * `publish_apps` / `publish_versions` (migration 0045); the version rows
 * themselves are read through `PostgresPublishStore.listVersions`.
 */

import type { Pool } from 'pg';

export interface PublishAppSummary {
  readonly appId: string;
  /** Name of the newest version — the app's current label. */
  readonly name: string;
  readonly currentVersion: number | null;
  readonly latestVersion: number;
  readonly versionCount: number;
  readonly updatedAt: Date;
}

interface AppRow {
  app_id: string;
  name: string;
  current_version: number | null;
  latest_version: number;
  version_count: string;
  updated_at: Date;
}

const APP_LIST_LIMIT = 500;

export async function listPublishApps(pool: Pool): Promise<PublishAppSummary[]> {
  const result = await pool.query<AppRow>(
    `SELECT v.app_id,
            (SELECT name FROM publish_versions n
              WHERE n.app_id = v.app_id ORDER BY n.version DESC LIMIT 1) AS name,
            a.current_version,
            max(v.version) AS latest_version,
            count(*) AS version_count,
            greatest(max(v.created_at), coalesce(a.updated_at, max(v.created_at))) AS updated_at
       FROM publish_versions v
       LEFT JOIN publish_apps a ON a.app_id = v.app_id
      GROUP BY v.app_id, a.current_version, a.updated_at
      ORDER BY updated_at DESC
      LIMIT $1`,
    [APP_LIST_LIMIT],
  );
  return result.rows.map((r) => ({
    appId: r.app_id,
    name: r.name,
    currentVersion: r.current_version,
    latestVersion: r.latest_version,
    versionCount: Number(r.version_count),
    updatedAt: r.updated_at,
  }));
}
