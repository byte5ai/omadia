// -----------------------------------------------------------------------------
// Bootstrap-Profile types. Mirrors middleware/src/routes/profiles.ts +
// middleware/src/plugins/profileLoader.ts. Keep in sync manually until the
// admin-api types are promoted to a shared package.
// -----------------------------------------------------------------------------

export interface ProfileSummary {
  id: string;
  name: string;
  description: string;
  plugin_count: number;
  plugin_ids: string[];
}

export interface ProfileListResponse {
  items: ProfileSummary[];
  total: number;
}

export interface ProfilePluginEntry {
  id: string;
  config: Record<string, unknown>;
}

export interface ProfileDetail {
  schema_version: 1;
  id: string;
  name: string;
  description: string;
  plugins: ProfilePluginEntry[];
}

export type ProfileApplyErrorReason =
  | 'not_in_catalog'
  | 'incompatible'
  | 'register_failed';

export interface ProfileApplyOutcome {
  profile_id: string;
  installed: Array<{ id: string; version: string }>;
  skipped: Array<{ id: string; reason: 'already_installed' }>;
  errored: Array<{
    id: string;
    reason: ProfileApplyErrorReason;
    message: string;
  }>;
}

// ── Phase 2.4 (OB-66) — Profile-Bundle import response ─────────────────────

export type ImportBundleSpecSource =
  | 'spec_json'
  | 'agent_md_fallback'
  | 'profile_no_spec';

export interface ImportBundlePluginInfo {
  id: string;
  version: string;
  was_existing: boolean;
  vendored: boolean;
}

export interface ImportBundleSuccess {
  ok: true;
  imported_as: 'draft' | 'profile';
  profile_id: string;
  draft_id?: string;
  plugins_installed: ImportBundlePluginInfo[];
  diverged_assets: string[];
  spec_source: ImportBundleSpecSource;
}
