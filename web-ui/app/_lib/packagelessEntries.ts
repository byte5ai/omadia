/**
 * Installed entries whose package is gone. The kernel reports them in
 * `GET /v1/admin/runtime/installed` with `package_missing: true`; no runtime
 * runs them, and the store's catalogue (built from packages) does not list
 * them, so without this they are visible nowhere.
 */

export interface RuntimeInstalledRow {
  id: string;
  installed_version: string;
  installed_at: string;
  status: string;
  /** Absent on a middleware that predates the field. */
  registry_status?: string;
  package_missing?: boolean;
}

export interface PackagelessEntry {
  id: string;
  version: string;
  installedAt: string;
}

export function packagelessEntriesOf(rows: readonly RuntimeInstalledRow[] | undefined): PackagelessEntry[] {
  return (rows ?? [])
    .filter((row) => row.package_missing === true)
    .map((row) => ({ id: row.id, version: row.installed_version, installedAt: row.installed_at }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
