import { adminJson, arrayField } from './adminJson';

/**
 * #2320 — typed client for the read-only version list of published apps
 * (#581, ADR-0067): `GET /v1/admin/publish/apps` and
 * `GET /v1/admin/publish/apps/:appId/versions`. Versions are immutable; the
 * live one is a pointer the `publish_rollback` tool moves, not this page.
 */

export interface PublishedAppDto {
  readonly app_id: string;
  readonly name: string;
  readonly current_version: number | null;
  readonly latest_version: number;
  readonly version_count: number;
  readonly updated_at: string;
}

export interface PublishedVersionDto {
  readonly version: number;
  readonly name: string;
  readonly entrypoint: string;
  readonly dir_hash: string;
  readonly source_scope_key: string;
  readonly created_at: string;
  readonly current: boolean;
}

export interface PublishedVersionsResponse {
  readonly app_id: string;
  readonly current_version: number | null;
  readonly versions: PublishedVersionDto[];
}

const APPS = '/v1/admin/publish/apps';

export async function listPublishedApps(): Promise<PublishedAppDto[]> {
  return arrayField<PublishedAppDto>(await adminJson(APPS), 'apps', APPS);
}

export async function listPublishedVersions(appId: string): Promise<PublishedVersionsResponse> {
  const path = `${APPS}/${encodeURIComponent(appId)}/versions`;
  const body = await adminJson<PublishedVersionsResponse>(path);
  return { ...body, versions: arrayField<PublishedVersionDto>(body, 'versions', path) };
}
