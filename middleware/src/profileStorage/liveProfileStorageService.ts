import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';

/**
 * Live (operator-edited) state of a profile's free-form artefacts: the
 * `agent.md` prose body and the `knowledge/*` attachments.
 *
 * Plugin pins live in `installedRegistry.installed_version` and are
 * NOT stored here — `getLiveProfileBundle` composes them at read-time so
 * Snapshots / Bundle-Export always see the canonical pin value.
 *
 * Validation lives in this service (filename, extension, size cap), NOT in
 * the routes — see feedback-server-validation memory.
 */

/**
 * Knowledge-file extension allowlist. Must stay in sync with
 * `KNOWLEDGE_EXT_ALLOWLIST` inside `profileBundleZipper.ts`. The bundle
 * zipper enforces the same set when composing a Profile-Bundle, so a
 * file rejected here would also be rejected at bundle time.
 */
const KNOWLEDGE_EXT_ALLOWLIST: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.pdf',
  '.json',
]);

/**
 * Per-file content cap. Stays well under the 50 MB Profile-Bundle cap
 * defined in Phase 2.1; in practice operators upload small reference
 * docs, not videos.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class ProfileStorageValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'profile_storage.invalid_profile_id'
      | 'profile_storage.invalid_filename'
      | 'profile_storage.disallowed_extension'
      | 'profile_storage.file_too_large',
  ) {
    super(message);
    this.name = 'ProfileStorageValidationError';
  }
}

export interface AgentMdRecord {
  content: Buffer;
  sha256: string;
  sizeBytes: number;
  updatedAt: Date;
  updatedBy: string;
}

export interface KnowledgeFileSummary {
  filename: string;
  sha256: string;
  sizeBytes: number;
  updatedAt: Date;
}

export interface KnowledgeFileRecord extends KnowledgeFileSummary {
  content: Buffer;
  updatedBy: string;
}

/**
 * Shape consumed by Phase 2.2 (Snapshots) and Phase 2.4 (Export). Aligned
 * with `ZipProfileBundleInput` from `profileBundleZipper.ts` so callers
 * can hand it through with a thin adapter.
 */
export interface LiveProfileState {
  profileId: string;
  profileName: string;
  profileVersion: string;
  agentMd: Buffer;
  pluginPins: Array<{ id: string; version: string; sha256?: string }>;
  knowledge: Array<{ filename: string; content: Buffer }>;
  /**
   * OB-83 — inline vendored plugin ZIP buffers, keyed by `<id>@<version>`.
   * Used by the Builder-aware loader to ship freshly-built plugin ZIPs
   * inside the snapshot bundle without round-tripping through the
   * UploadedPackageStore. The bundle zipper consumes this map when it
   * sees a matching `pluginPins[]` entry with `sha256` set; the inner
   * ZIP lands at `plugins/<id>-<version>.zip`.
   */
  inlineVendoredPlugins?: Map<string, Buffer>;
}

export interface LiveProfileStorageDeps {
  pool: Pool;
  log?: (msg: string) => void;
}

export class LiveProfileStorageService {
  constructor(private readonly deps: LiveProfileStorageDeps) {}

  // ── agent.md ───────────────────────────────────────────────────────────

  async getAgentMd(profileId: string): Promise<AgentMdRecord | null> {
    assertProfileId(profileId);
    const res = await this.deps.pool.query<{
      content: Buffer;
      sha256: string;
      size_bytes: number;
      updated_at: Date;
      updated_by: string;
    }>(
      `SELECT content, sha256, size_bytes, updated_at, updated_by
         FROM profile_agent_md
        WHERE profile_id = $1`,
      [profileId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      content: row.content,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async setAgentMd(
    profileId: string,
    content: Buffer,
    updatedBy: string,
  ): Promise<AgentMdRecord> {
    assertProfileId(profileId);
    assertSize(content);
    assertActor(updatedBy);
    const sha256 = sha256Hex(content);
    const sizeBytes = content.byteLength;
    const res = await this.deps.pool.query<{ updated_at: Date }>(
      `INSERT INTO profile_agent_md
         (profile_id, content, sha256, size_bytes, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (profile_id) DO UPDATE
         SET content    = EXCLUDED.content,
             sha256     = EXCLUDED.sha256,
             size_bytes = EXCLUDED.size_bytes,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [profileId, content, sha256, sizeBytes, updatedBy],
    );
    return {
      content,
      sha256,
      sizeBytes,
      updatedAt: res.rows[0]!.updated_at,
      updatedBy,
    };
  }

  // ── knowledge/* ────────────────────────────────────────────────────────

  async listKnowledge(profileId: string): Promise<KnowledgeFileSummary[]> {
    assertProfileId(profileId);
    const res = await this.deps.pool.query<{
      filename: string;
      sha256: string;
      size_bytes: number;
      updated_at: Date;
    }>(
      `SELECT filename, sha256, size_bytes, updated_at
         FROM profile_knowledge_file
        WHERE profile_id = $1
        ORDER BY filename ASC`,
      [profileId],
    );
    return res.rows.map((row) => ({
      filename: row.filename,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      updatedAt: row.updated_at,
    }));
  }

  async getKnowledgeFile(
    profileId: string,
    filename: string,
  ): Promise<KnowledgeFileRecord | null> {
    assertProfileId(profileId);
    assertFilename(filename);
    const res = await this.deps.pool.query<{
      content: Buffer;
      sha256: string;
      size_bytes: number;
      updated_at: Date;
      updated_by: string;
    }>(
      `SELECT content, sha256, size_bytes, updated_at, updated_by
         FROM profile_knowledge_file
        WHERE profile_id = $1 AND filename = $2`,
      [profileId, filename],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      filename,
      content: row.content,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async setKnowledgeFile(
    profileId: string,
    filename: string,
    content: Buffer,
    updatedBy: string,
  ): Promise<KnowledgeFileSummary> {
    assertProfileId(profileId);
    assertFilename(filename);
    assertSize(content);
    assertActor(updatedBy);
    const sha256 = sha256Hex(content);
    const sizeBytes = content.byteLength;
    const res = await this.deps.pool.query<{ updated_at: Date }>(
      `INSERT INTO profile_knowledge_file
         (profile_id, filename, content, sha256, size_bytes, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (profile_id, filename) DO UPDATE
         SET content    = EXCLUDED.content,
             sha256     = EXCLUDED.sha256,
             size_bytes = EXCLUDED.size_bytes,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [profileId, filename, content, sha256, sizeBytes, updatedBy],
    );
    return {
      filename,
      sha256,
      sizeBytes,
      updatedAt: res.rows[0]!.updated_at,
    };
  }

  /** Idempotent — deleting a non-existent file is a no-op. */
  async removeKnowledgeFile(
    profileId: string,
    filename: string,
  ): Promise<{ removed: boolean }> {
    assertProfileId(profileId);
    assertFilename(filename);
    const res = await this.deps.pool.query(
      `DELETE FROM profile_knowledge_file
        WHERE profile_id = $1 AND filename = $2`,
      [profileId, filename],
    );
    return { removed: (res.rowCount ?? 0) > 0 };
  }

  // ── composite read for Snapshot / Export consumers ─────────────────────

  /**
   * Compose the live state of a profile for Snapshot (Phase 2.2) and
   * Export (Phase 2.4) consumers. agent.md falls back to an empty buffer
   * if no row has been written yet — that's the canonical "fresh
   * profile" state.
   *
   * Profile-Version: until Phase 2.5 (Persona-UI) extends the profile
   * schema with a semver field, this defaults to '1.0.0' so the bundle
   * manifest passes Zod validation.
   */
  async getLiveProfileBundle(input: {
    profileId: string;
    profileName: string;
    profileVersion?: string;
    pluginRegistry: InstalledRegistry;
  }): Promise<LiveProfileState> {
    assertProfileId(input.profileId);

    const [agent, knowledgeSummaries] = await Promise.all([
      this.getAgentMd(input.profileId),
      this.listKnowledge(input.profileId),
    ]);

    const knowledge = await Promise.all(
      knowledgeSummaries.map(async (s) => {
        const rec = await this.getKnowledgeFile(input.profileId, s.filename);
        if (!rec) {
          throw new Error(
            `internal: knowledge row vanished between list and read for ${input.profileId}/${s.filename}`,
          );
        }
        return { filename: rec.filename, content: rec.content };
      }),
    );

    const pluginPins = input.pluginRegistry
      .list()
      .map((entry) => ({ id: entry.id, version: entry.installed_version }));

    return {
      profileId: input.profileId,
      profileName: input.profileName,
      profileVersion: input.profileVersion ?? '1.0.0',
      agentMd: agent?.content ?? Buffer.alloc(0),
      pluginPins,
      knowledge,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function assertProfileId(profileId: string): void {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new ProfileStorageValidationError(
      `profile id must match ${PROFILE_ID_PATTERN}; got '${profileId}'`,
      'profile_storage.invalid_profile_id',
    );
  }
}

function assertFilename(filename: string): void {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename.startsWith('.')
  ) {
    throw new ProfileStorageValidationError(
      `knowledge filename must be a flat name without path separators or leading dot; got '${filename}'`,
      'profile_storage.invalid_filename',
    );
  }
  const ext = path.extname(filename).toLowerCase();
  if (!KNOWLEDGE_EXT_ALLOWLIST.has(ext)) {
    throw new ProfileStorageValidationError(
      `knowledge filename '${filename}' has disallowed extension '${ext}' (allowed: ${[...KNOWLEDGE_EXT_ALLOWLIST].join(', ')})`,
      'profile_storage.disallowed_extension',
    );
  }
}

function assertSize(content: Buffer): void {
  if (!Buffer.isBuffer(content)) {
    throw new ProfileStorageValidationError(
      'content must be a Buffer',
      'profile_storage.file_too_large',
    );
  }
  if (content.byteLength > MAX_FILE_BYTES) {
    throw new ProfileStorageValidationError(
      `content exceeds ${MAX_FILE_BYTES} bytes (got ${content.byteLength})`,
      'profile_storage.file_too_large',
    );
  }
}

function assertActor(updatedBy: string): void {
  if (typeof updatedBy !== 'string' || updatedBy.length === 0) {
    throw new ProfileStorageValidationError(
      'updatedBy must be a non-empty string',
      'profile_storage.invalid_profile_id',
    );
  }
}
