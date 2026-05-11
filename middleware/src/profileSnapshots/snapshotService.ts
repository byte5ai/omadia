import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { parse as parseYaml } from 'yaml';
import yauzl from 'yauzl';
import yazl from 'yazl';

import type { PersistedBundlePayload } from '../plugins/profileBundleImporter.js';
import { ProfileBundleManifestSchema } from '../plugins/profileBundleManifest.js';
import {
  zipProfileBundle,
  type ZipperDeps,
  type ZipProfileBundleResult,
} from '../plugins/profileBundleZipper.js';
import { stringify as stringifyYaml } from 'yaml';
import type { LiveProfileState } from '../profileStorage/liveProfileStorageService.js';

/**
 * Profile-Snapshot service (Phase 2.2 of the Kemia integration, OB-64).
 *
 * Responsibilities for the *create + read* slice (Phase 2.2-B):
 *   - createSnapshot: capture the live profile state via `profileLoader`,
 *     serialise via `zipProfileBundle`, persist atomically across
 *     profile_snapshot + profile_snapshot_asset + profile_health_score.
 *     Idempotent — UNIQUE (profile_id, bundle_hash) returns the
 *     existing snapshot on conflict (was_existing=true).
 *   - listSnapshots / getSnapshot / getAssetBytes: read-only inspection.
 *
 * Mark-deploy-ready, rollback, diff land in Phase 2.2-C; admin-UI is
 * Phase 2.2-E. Drift-score writes beyond the initial 0 are Phase 2.3.
 *
 * Architecture rules (from HANDOFF docs/harness-platform/HANDOFF-2026-05-07-kemia-phase-2.2-snapshots.md):
 *   1. Snapshots are immutable. No UPDATE on bundle_hash, manifest_yaml,
 *      or asset bytes. Only is_deploy_ready + audit fields mutate.
 *   2. Bytes in DB, not S3 / disk. 50 MB cap from Phase 2.1.
 *   3. BundleZipper is reused, not cloned.
 *   4. Idempotency via bundle_hash UNIQUE.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface SnapshotServiceDeps {
  pool: Pool;
  zipperDeps: ZipperDeps;
  /** Resolves a profile id to its live (operator-edited) state. In
   *  production this is wrapped around `LiveProfileStorageService.getLiveProfileBundle`. */
  profileLoader: (profileId: string) => Promise<LiveProfileState>;
  log?: (msg: string) => void;
}

export interface CreateSnapshotInput {
  profileId: string;
  createdBy: string;
  notes?: string;
  vendorPlugins?: boolean;
}

export interface CreateSnapshotResult {
  snapshotId: string;
  bundleHash: string;
  bundleSizeBytes: number;
  createdAt: Date;
  wasExisting: boolean;
}

export interface SnapshotSummary {
  snapshotId: string;
  profileId: string;
  profileVersion: string;
  bundleHash: string;
  bundleSizeBytes: number;
  createdAt: Date;
  createdBy: string;
  notes: string | null;
  isDeployReady: boolean;
  deployReadyAt: Date | null;
  deployReadyBy: string | null;
}

export interface SnapshotAssetSummary {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface SnapshotDetail extends SnapshotSummary {
  manifestYaml: string;
  assets: SnapshotAssetSummary[];
  /** drift_score from the most recent profile_health_score row. */
  driftScore: number | null;
}

export class SnapshotValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'snapshot.invalid_profile_id'
      | 'snapshot.invalid_snapshot_id'
      | 'snapshot.invalid_actor',
  ) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

export class SnapshotNotFoundError extends Error {
  constructor(public readonly snapshotId: string) {
    super(`snapshot ${snapshotId} not found`);
    this.name = 'SnapshotNotFoundError';
  }
  readonly code = 'snapshot.not_found' as const;
}

export class SnapshotIntegrityError extends Error {
  constructor(message: string, public readonly snapshotId: string) {
    super(message);
    this.name = 'SnapshotIntegrityError';
  }
  readonly code = 'snapshot.integrity_error' as const;
}

export interface MarkDeployReadyInput {
  snapshotId: string;
  operator: string;
}

export interface RollbackInput {
  snapshotId: string;
  operator: string;
  /**
   * Persistence sink for the reconstructed profile state. Re-uses the
   * Phase-2.1 `BundleImporter.onPersist` shape — production wires it to
   * `LiveProfileStorageService.setAgentMd` + `setKnowledgeFile`.
   *
   * Plugin pins are passed through informationally; the rollback path
   * does NOT install plugins (drift in plugin versions is Phase-2.3 worker
   * territory).
   */
  onPersist: (payload: PersistedBundlePayload) => Promise<void>;
}

export interface RollbackResult {
  rolledBackTo: { snapshotId: string; bundleHash: string };
  appliedAt: Date;
  /**
   * Asset paths that differed between live state and the snapshot at the
   * moment rollback was triggered. Captured pre-rollback so the audit log
   * shows what changed.
   */
  divergedAssets: string[];
}

export type DiffSide =
  | { kind: 'snapshot'; snapshotId: string }
  | { kind: 'live'; profileId: string };

export interface DiffInput {
  base: DiffSide;
  target: DiffSide;
}

export interface AssetDiff {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'identical';
  baseSha256: string | null;
  targetSha256: string | null;
}

export class SnapshotService {
  constructor(private readonly deps: SnapshotServiceDeps) {}

  // ── create ──────────────────────────────────────────────────────────────

  async createSnapshot(input: CreateSnapshotInput): Promise<CreateSnapshotResult> {
    assertProfileId(input.profileId);
    assertActor(input.createdBy);

    const live = await this.deps.profileLoader(input.profileId);

    const zipResult: ZipProfileBundleResult = await zipProfileBundle(
      this.deps.zipperDeps,
      {
        profileId: live.profileId,
        profileName: live.profileName,
        profileVersion: live.profileVersion,
        createdBy: input.createdBy,
        agentMd: live.agentMd,
        pluginPins: live.pluginPins,
        knowledge: live.knowledge,
        vendorPlugins: input.vendorPlugins ?? false,
        ...(live.inlineVendoredPlugins
          ? { inlineVendoredPlugins: live.inlineVendoredPlugins }
          : {}),
      },
    );

    const assets = await extractEntries(zipResult.buffer);
    const manifestYaml = stringifyYaml(zipResult.manifest);
    const bundleHash = zipResult.manifest.bundle_hash;
    const bundleSizeBytes = zipResult.buffer.byteLength;

    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO profile_snapshot
           (profile_id, profile_version, bundle_hash, manifest_yaml,
            bundle_size_bytes, created_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (profile_id, bundle_hash) DO NOTHING
         RETURNING id, created_at`,
        [
          live.profileId,
          live.profileVersion,
          bundleHash,
          manifestYaml,
          bundleSizeBytes,
          input.createdBy,
          input.notes ?? null,
        ],
      );

      if (inserted.rowCount === 0) {
        // Hash collision → existing snapshot. Look it up and return it.
        const existing = await client.query<{ id: string; created_at: Date }>(
          `SELECT id, created_at FROM profile_snapshot
            WHERE profile_id = $1 AND bundle_hash = $2`,
          [live.profileId, bundleHash],
        );
        await client.query('COMMIT');
        const row = existing.rows[0];
        if (!row) {
          throw new Error(
            `internal: ON CONFLICT but no row found for ${live.profileId}@${bundleHash.slice(0, 12)}`,
          );
        }
        this.log(
          `[snapshot] existing snapshot returned for ${live.profileId} (bundle_hash=${bundleHash.slice(0, 12)})`,
        );
        return {
          snapshotId: row.id,
          bundleHash,
          bundleSizeBytes,
          createdAt: row.created_at,
          wasExisting: true,
        };
      }

      const created = inserted.rows[0]!;
      const snapshotId = created.id;

      for (const asset of assets) {
        await client.query(
          `INSERT INTO profile_snapshot_asset
             (snapshot_id, path, content, sha256, size_bytes)
           VALUES ($1, $2, $3, $4, $5)`,
          [snapshotId, asset.path, asset.content, asset.sha256, asset.sizeBytes],
        );
      }

      // Initial health score: drift vs. itself is identical. Phase 2.3
      // (Drift-Worker) writes additional rows over time as the live state moves.
      await client.query(
        `INSERT INTO profile_health_score
           (snapshot_id, drift_score, diverged_assets)
         VALUES ($1, 0, '[]'::jsonb)`,
        [snapshotId],
      );

      await client.query('COMMIT');
      this.log(
        `[snapshot] created ${snapshotId} for ${live.profileId} (bundle_hash=${bundleHash.slice(0, 12)}, assets=${assets.length})`,
      );

      return {
        snapshotId,
        bundleHash,
        bundleSizeBytes,
        createdAt: created.created_at,
        wasExisting: false,
      };
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── read paths ──────────────────────────────────────────────────────────

  async listSnapshots(profileId: string): Promise<SnapshotSummary[]> {
    assertProfileId(profileId);
    const res = await this.deps.pool.query<SnapshotRow>(
      `SELECT
         id, profile_id, profile_version, bundle_hash, bundle_size_bytes,
         created_at, created_by, notes,
         is_deploy_ready, deploy_ready_at, deploy_ready_by
       FROM profile_snapshot
       WHERE profile_id = $1
       ORDER BY created_at DESC`,
      [profileId],
    );
    return res.rows.map(rowToSummary);
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotDetail | null> {
    assertSnapshotId(snapshotId);
    const baseRes = await this.deps.pool.query<
      SnapshotRow & { manifest_yaml: string }
    >(
      `SELECT
         id, profile_id, profile_version, bundle_hash, bundle_size_bytes,
         created_at, created_by, notes,
         is_deploy_ready, deploy_ready_at, deploy_ready_by, manifest_yaml
       FROM profile_snapshot
       WHERE id = $1`,
      [snapshotId],
    );
    const row = baseRes.rows[0];
    if (!row) return null;

    const assetsRes = await this.deps.pool.query<{
      path: string;
      sha256: string;
      size_bytes: number;
    }>(
      `SELECT path, sha256, size_bytes
         FROM profile_snapshot_asset
        WHERE snapshot_id = $1
        ORDER BY path ASC`,
      [snapshotId],
    );

    const driftRes = await this.deps.pool.query<{ drift_score: string }>(
      `SELECT drift_score
         FROM profile_health_score
        WHERE snapshot_id = $1
        ORDER BY computed_at DESC
        LIMIT 1`,
      [snapshotId],
    );

    return {
      ...rowToSummary(row),
      manifestYaml: row.manifest_yaml,
      assets: assetsRes.rows.map((a) => ({
        path: a.path,
        sha256: a.sha256,
        sizeBytes: a.size_bytes,
      })),
      driftScore: driftRes.rows[0]
        ? Number(driftRes.rows[0].drift_score)
        : null,
    };
  }

  /**
   * Reassemble the full snapshot bundle ZIP from stored asset rows. The
   * resulting bytes have the same `bundle_hash` as the snapshot was
   * created with — entries are written in lexicographic path order with
   * a fixed mtime so the zip is deterministic. Used by the download
   * endpoint (Slice D).
   */
  async assembleBundle(snapshotId: string): Promise<Buffer | null> {
    assertSnapshotId(snapshotId);
    const res = await this.deps.pool.query<{
      path: string;
      content: Buffer;
    }>(
      `SELECT path, content FROM profile_snapshot_asset
        WHERE snapshot_id = $1
        ORDER BY path ASC`,
      [snapshotId],
    );
    if (res.rowCount === 0) return null;
    return zipAssets(res.rows);
  }

  async getAssetBytes(
    snapshotId: string,
    path: string,
  ): Promise<Buffer | null> {
    assertSnapshotId(snapshotId);
    if (typeof path !== 'string' || path.length === 0) return null;
    const res = await this.deps.pool.query<{ content: Buffer }>(
      `SELECT content FROM profile_snapshot_asset
        WHERE snapshot_id = $1 AND path = $2`,
      [snapshotId, path],
    );
    return res.rows[0]?.content ?? null;
  }

  // ── mutation paths (Slice C) ────────────────────────────────────────────

  /**
   * Mark a snapshot as a deploy-ready candidate. Idempotent: a second mark
   * on an already-deploy-ready snapshot updates only the audit fields.
   * Audit-log writing is the routes layer's responsibility — this service
   * stays audit-free so it can be called from worker contexts (e.g. Phase
   * 2.3 Drift-Worker auto-marking healthy snapshots).
   */
  async markDeployReady(input: MarkDeployReadyInput): Promise<SnapshotSummary> {
    assertSnapshotId(input.snapshotId);
    assertActor(input.operator);

    const res = await this.deps.pool.query<SnapshotRow>(
      `UPDATE profile_snapshot
          SET is_deploy_ready = true,
              deploy_ready_at = now(),
              deploy_ready_by = $2
        WHERE id = $1
        RETURNING id, profile_id, profile_version, bundle_hash,
                  bundle_size_bytes, created_at, created_by, notes,
                  is_deploy_ready, deploy_ready_at, deploy_ready_by`,
      [input.snapshotId, input.operator],
    );
    const row = res.rows[0];
    if (!row) throw new SnapshotNotFoundError(input.snapshotId);
    this.log(
      `[snapshot] mark-deploy-ready ${input.snapshotId} by ${input.operator}`,
    );
    return rowToSummary(row);
  }

  /**
   * Restore the live profile state to the bytes captured in a snapshot.
   * The reconstructed `PersistedBundlePayload` is handed off through
   * `onPersist` — production wires that to `LiveProfileStorageService.setAgentMd`
   * + `setKnowledgeFile`. Plugin pins are not modified by rollback (see
   * architecture rule #6 in the HANDOFF — plugin drift is Phase 2.3).
   *
   * The pre-rollback diff (live vs. snapshot) is computed and returned so
   * the routes layer can put it in the audit payload.
   */
  async rollback(input: RollbackInput): Promise<RollbackResult> {
    assertSnapshotId(input.snapshotId);
    assertActor(input.operator);

    const detail = await this.getSnapshot(input.snapshotId);
    if (!detail) throw new SnapshotNotFoundError(input.snapshotId);

    const manifestRaw: unknown = parseYaml(detail.manifestYaml);
    const manifestParse = ProfileBundleManifestSchema.safeParse(manifestRaw);
    if (!manifestParse.success) {
      throw new SnapshotIntegrityError(
        `snapshot ${input.snapshotId} manifest failed schema validation: ${manifestParse.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
        input.snapshotId,
      );
    }
    const manifest = manifestParse.data;

    // Pre-rollback diff for the audit payload — record what was about to
    // change before we mutated the live state.
    const divergedAssets = (
      await this.diff({
        base: { kind: 'live', profileId: detail.profileId },
        target: { kind: 'snapshot', snapshotId: input.snapshotId },
      })
    )
      .filter((d) => d.status !== 'identical')
      .map((d) => d.path);

    // Reassemble the agent.md + knowledge bytes from snapshot assets.
    const agentMd = await this.getAssetBytes(input.snapshotId, 'agent.md');
    if (!agentMd) {
      throw new SnapshotIntegrityError(
        `snapshot ${input.snapshotId} is missing agent.md asset`,
        input.snapshotId,
      );
    }

    const knowledge: Array<{ filename: string; content: Buffer }> = [];
    for (const asset of detail.assets) {
      if (!asset.path.startsWith('knowledge/')) continue;
      const bytes = await this.getAssetBytes(input.snapshotId, asset.path);
      if (!bytes) {
        throw new SnapshotIntegrityError(
          `snapshot ${input.snapshotId} is missing knowledge asset ${asset.path}`,
          input.snapshotId,
        );
      }
      knowledge.push({ filename: asset.path, content: bytes });
    }

    const persistedPlugins: PersistedBundlePayload['plugins'] = manifest.plugins.map(
      (p) => ({
        id: p.id,
        version: p.version,
        sha256: p.sha256,
        vendored: p.vendored,
        installed: false, // rollback does not install plugins
      }),
    );

    await input.onPersist({
      manifest,
      agentMd,
      knowledge,
      plugins: persistedPlugins,
    });

    const appliedAt = new Date();
    this.log(
      `[snapshot] rollback ${input.snapshotId} for ${detail.profileId} by ${input.operator} (diverged_assets=${divergedAssets.length})`,
    );
    return {
      rolledBackTo: {
        snapshotId: input.snapshotId,
        bundleHash: detail.bundleHash,
      },
      appliedAt,
      divergedAssets,
    };
  }

  /**
   * Asset-level diff between two sides — each side is either a snapshot
   * (read from `profile_snapshot_asset`) or the live state (read via the
   * `profileLoader` dep). Diff is scoped to user-controlled content
   * (`agent.md` + `knowledge/*`); the auto-generated `profile-manifest.yaml`
   * and `plugins.lock` are intentionally excluded — comparing them would
   * report noise on every snapshot since manifests carry timestamps.
   */
  async diff(input: DiffInput): Promise<AssetDiff[]> {
    const [base, target] = await Promise.all([
      this.materializeAssetMap(input.base),
      this.materializeAssetMap(input.target),
    ]);

    const allPaths = new Set<string>([...base.keys(), ...target.keys()]);
    const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));
    const diffs: AssetDiff[] = [];
    for (const p of sortedPaths) {
      const baseHash = base.get(p) ?? null;
      const targetHash = target.get(p) ?? null;
      let status: AssetDiff['status'];
      if (baseHash && !targetHash) status = 'removed';
      else if (!baseHash && targetHash) status = 'added';
      else if (baseHash !== targetHash) status = 'modified';
      else status = 'identical';
      diffs.push({ path: p, status, baseSha256: baseHash, targetSha256: targetHash });
    }
    return diffs;
  }

  private async materializeAssetMap(
    side: DiffSide,
  ): Promise<Map<string, string>> {
    if (side.kind === 'snapshot') {
      assertSnapshotId(side.snapshotId);
      const detail = await this.getSnapshot(side.snapshotId);
      if (!detail) throw new SnapshotNotFoundError(side.snapshotId);
      const map = new Map<string, string>();
      for (const a of detail.assets) {
        if (!isDiffablePath(a.path)) continue;
        map.set(a.path, a.sha256);
      }
      return map;
    }
    // live side: hash agent.md + knowledge bytes via profileLoader
    assertProfileId(side.profileId);
    const live = await this.deps.profileLoader(side.profileId);
    const map = new Map<string, string>();
    map.set('agent.md', sha256Hex(live.agentMd));
    for (const k of live.knowledge) {
      const path = k.filename.startsWith('knowledge/')
        ? k.filename
        : `knowledge/${k.filename}`;
      map.set(path, sha256Hex(k.content));
    }
    return map;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private log(msg: string): void {
    (this.deps.log ?? (() => undefined))(msg);
  }
}

function isDiffablePath(p: string): boolean {
  if (p === 'agent.md') return true;
  if (p.startsWith('knowledge/')) return true;
  return false;
}

function zipAssets(
  assets: ReadonlyArray<{ path: string; content: Buffer }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    const mtime = new Date(0);
    for (const a of assets) {
      zip.addBuffer(a.content, a.path, { mtime, compress: true });
    }
    zip.end();
  });
}

// ── row mapper ─────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  profile_id: string;
  profile_version: string;
  bundle_hash: string;
  bundle_size_bytes: string | number;
  created_at: Date;
  created_by: string;
  notes: string | null;
  is_deploy_ready: boolean;
  deploy_ready_at: Date | null;
  deploy_ready_by: string | null;
}

function rowToSummary(row: SnapshotRow): SnapshotSummary {
  return {
    snapshotId: row.id,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    bundleHash: row.bundle_hash,
    bundleSizeBytes: Number(row.bundle_size_bytes),
    createdAt: row.created_at,
    createdBy: row.created_by,
    notes: row.notes,
    isDeployReady: row.is_deploy_ready,
    deployReadyAt: row.deploy_ready_at,
    deployReadyBy: row.deploy_ready_by,
  };
}

// ── zip-buffer entry extractor (yauzl in-memory) ───────────────────────────

interface ExtractedEntry {
  path: string;
  content: Buffer;
  sha256: string;
  sizeBytes: number;
}

const MAX_EXTRACT_ENTRIES = 4096;
const MAX_EXTRACT_BYTES = 100 * 1024 * 1024;

function extractEntries(buffer: Buffer): Promise<ExtractedEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('cannot open snapshot bundle for extraction'));
        return;
      }
      const out: ExtractedEntry[] = [];
      let totalBytes = 0;
      let entryCount = 0;
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve(out));
      zipfile.on('entry', (entry: yauzl.Entry) => {
        entryCount += 1;
        if (entryCount > MAX_EXTRACT_ENTRIES) {
          reject(new Error(`snapshot bundle has more than ${MAX_EXTRACT_ENTRIES} entries`));
          return;
        }
        // Skip directory entries (yazl emits files only, but be defensive)
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (rsErr, readStream) => {
          if (rsErr || !readStream) {
            reject(rsErr ?? new Error(`cannot open entry stream for ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_EXTRACT_BYTES) {
              reject(new Error(`snapshot bundle exceeds ${MAX_EXTRACT_BYTES} extracted bytes`));
              return;
            }
            chunks.push(chunk);
          });
          readStream.on('end', () => {
            const content = Buffer.concat(chunks);
            out.push({
              path: entry.fileName,
              content,
              sha256: sha256Hex(content),
              sizeBytes: content.byteLength,
            });
            zipfile.readEntry();
          });
          readStream.on('error', reject);
        });
      });
      zipfile.readEntry();
    });
  });
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* swallow — connection may be unusable; release will dispose it */
  }
}

function assertProfileId(profileId: string): void {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new SnapshotValidationError(
      `profile id must match ${PROFILE_ID_PATTERN}; got '${profileId}'`,
      'snapshot.invalid_profile_id',
    );
  }
}

function assertSnapshotId(snapshotId: string): void {
  if (typeof snapshotId !== 'string' || !UUID_PATTERN.test(snapshotId)) {
    throw new SnapshotValidationError(
      `snapshot id must be a UUID; got '${snapshotId}'`,
      'snapshot.invalid_snapshot_id',
    );
  }
}

function assertActor(actor: string): void {
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new SnapshotValidationError(
      'createdBy must be a non-empty string',
      'snapshot.invalid_actor',
    );
  }
}
