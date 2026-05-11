import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Platform-owned filesystem paths. Centralised so that future persistence
 * layers (plugin manifests, backups, caches) have a single source of truth.
 *
 * Layout:
 *   <middleware>/data/                       (git-ignored)
 *     vault.enc.json                         encrypted secret vault
 *     installed.json                         installed-agents registry
 *     .dev-vault.key                         auto-generated master key (dev only)
 *
 * In production, pass the master key via VAULT_KEY (32 bytes, base64).
 * When VAULT_KEY is unset the platform falls back to .dev-vault.key — convenient
 * for local dev, unacceptable for prod (the key lives next to the vault).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_ROOT = path.resolve(HERE, '..', '..');

export const DATA_DIR = process.env['PLATFORM_DATA_DIR']
  ? path.resolve(process.env['PLATFORM_DATA_DIR'])
  : path.join(MIDDLEWARE_ROOT, 'data');

export const VAULT_PATH = path.join(DATA_DIR, 'vault.enc.json');
export const INSTALLED_REGISTRY_PATH = path.join(DATA_DIR, 'installed.json');
export const DEV_VAULT_KEY_PATH = path.join(DATA_DIR, '.dev-vault.key');

/**
 * Agent-Builder: SQLite database for persistent drafts (Agent-Builder MVP
 * Phase B.0). Lives on the same Fly volume as the vault so a redeploy keeps
 * every user's in-flight agent drafts. WAL mode sidecars `drafts.db-wal` and
 * `drafts.db-shm` appear next to the main file — both must be included in
 * any backup path that covers this directory.
 */
export const BUILDER_DIR = path.join(DATA_DIR, 'builder');
export const DRAFTS_DB_PATH = path.join(BUILDER_DIR, 'drafts.db');

/**
 * Agent-Builder preview-runtime roots (Phase B.3).
 *   - `BUILDER_PREVIEWS_DIR`: ephemeral per-draft package extracts —
 *     `<agentSlug>-<rev>/`. Wiped on boot (orphan cleanup) and on cache evict.
 *   - `BUILDER_BUILD_TEMPLATE_DIR`: shared `node_modules` install reused by
 *     every staging dir (`<draftId>-<buildN>-<ts>/`) via symlink. The staging
 *     dirs themselves live next to the template root in `staging/` and are
 *     cleaned up by BuildPipeline after each run.
 *
 * Both directories are inside `BUILDER_DIR` so a single Fly-volume snapshot
 * captures everything builder-related.
 */
export const BUILDER_PREVIEWS_DIR = path.join(BUILDER_DIR, '.previews');
export const BUILDER_BUILD_TEMPLATE_DIR = path.join(BUILDER_DIR, 'build-template');
export const BUILDER_STAGING_DIR = path.join(BUILDER_DIR, 'staging');

/**
 * Per-plugin scratch roots. Each plugin that declares `filesystem.scratch:
 * true` gets a subdirectory `<SCRATCH_DIR>/<agentId>/` on first ctx.scratch.
 * path() call. Cleanup happens best-effort on uninstall.
 */
export const SCRATCH_DIR = path.join(DATA_DIR, 'scratch');
