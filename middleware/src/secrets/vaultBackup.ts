import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

/**
 * Nightly off-site backup of the encrypted vault (and the installed-agents
 * registry) to a Tigris / S3 bucket.
 *
 * Design rules:
 *   1. Only ciphertext leaves the box. The master key (VAULT_KEY) is never
 *      touched or uploaded — a bucket compromise alone cannot decrypt.
 *   2. One daily snapshot per file, keyed by UTC date. Running twice on the
 *      same day overwrites the same object (idempotent).
 *   3. Retention is best-effort: after every successful snapshot the backup
 *      list is pruned to the N newest objects per file. Errors during prune
 *      do not fail the snapshot.
 *   4. Status is observable via `getStatus()` — surfaced at
 *      /api/v1/admin/vault-status so an operator can confirm without SSH.
 */

export interface VaultBackupOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  retention: number;
  intervalHours: number;
  files: VaultBackupFile[];
  log?: (msg: string) => void;
}

export interface VaultBackupFile {
  /** Local absolute path of the file to back up. */
  localPath: string;
  /**
   * Stable name used inside the bucket (`<prefix><name>/<date>.<ext>`).
   * Keep short and kebab-case.
   */
  name: string;
  /** Content-Type uploaded with the object. */
  contentType: string;
}

export interface VaultBackupStatus {
  enabled: boolean;
  bucket: string;
  prefix: string;
  retention: number;
  intervalHours: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  objectsKept: number | null;
}

export class VaultBackupService {
  private readonly s3: S3Client;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private status: VaultBackupStatus;

  constructor(private readonly opts: VaultBackupOptions) {
    const clientConfig: S3ClientConfig = {
      region: 'auto',
      endpoint: opts.endpoint,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: true,
    };
    this.s3 = new S3Client(clientConfig);
    this.status = {
      enabled: true,
      bucket: opts.bucket,
      prefix: opts.prefix,
      retention: opts.retention,
      intervalHours: opts.intervalHours,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      objectsKept: null,
    };
  }

  getStatus(): VaultBackupStatus {
    return { ...this.status };
  }

  /**
   * Kick off the nightly loop. The first snapshot runs after a short delay
   * (60s) so we don't block middleware boot; subsequent runs are spaced by
   * `intervalHours`.
   */
  start(): void {
    if (this.timer) return;
    const log = this.opts.log ?? ((m) => console.log(m));
    log(
      `[vault-backup] scheduler armed — bucket=${this.opts.bucket} prefix=${this.opts.prefix} ` +
        `interval=${this.opts.intervalHours}h retention=${this.opts.retention}`,
    );
    const initialDelayMs = 60_000;
    this.status.nextRunAt = new Date(Date.now() + initialDelayMs).toISOString();
    this.timer = setTimeout(() => void this.tick(), initialDelayMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run a single snapshot immediately. Exposed for manual trigger / tests. */
  async runOnce(): Promise<VaultBackupStatus> {
    await this.tick(false);
    return this.getStatus();
  }

  private async tick(scheduleNext: boolean = true): Promise<void> {
    if (this.running) return;
    this.running = true;
    const log = this.opts.log ?? ((m) => console.log(m));
    this.status.lastRunAt = new Date().toISOString();
    try {
      const day = isoDate(new Date());
      let totalKept = 0;
      for (const file of this.opts.files) {
        await this.snapshotFile(file, day);
        totalKept += await this.pruneFile(file);
      }
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = null;
      this.status.objectsKept = totalKept;
      log(
        `[vault-backup] snapshot ok (files=${this.opts.files.length}, kept=${totalKept})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.lastError = message;
      log(`[vault-backup] snapshot FAILED: ${message}`);
    } finally {
      this.running = false;
      if (scheduleNext && this.timer !== null) {
        const nextMs = this.opts.intervalHours * 60 * 60 * 1000;
        this.status.nextRunAt = new Date(Date.now() + nextMs).toISOString();
        this.timer = setTimeout(() => void this.tick(), nextMs);
      }
    }
  }

  private async snapshotFile(
    file: VaultBackupFile,
    day: string,
  ): Promise<void> {
    let body: Buffer;
    try {
      body = await fs.readFile(file.localPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        // Vault has never been written yet (fresh install). Silently skip —
        // nothing to back up, not a failure.
        return;
      }
      throw err;
    }
    const ext = path.extname(file.localPath) || '.bin';
    const key = `${this.opts.prefix}${file.name}/${day}${ext}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: file.contentType,
        CacheControl: 'private, max-age=0, no-store',
      }),
    );
  }

  private async pruneFile(file: VaultBackupFile): Promise<number> {
    const prefix = `${this.opts.prefix}${file.name}/`;
    const list = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.opts.bucket,
        Prefix: prefix,
      }),
    );
    const contents = list.Contents ?? [];
    // Sort newest first so slicing after `retention` drops the oldest.
    const sorted = contents
      .filter((o) => o.Key && o.LastModified)
      .sort((a, b) => {
        const ta = a.LastModified ? a.LastModified.getTime() : 0;
        const tb = b.LastModified ? b.LastModified.getTime() : 0;
        return tb - ta;
      });
    const toDelete = sorted.slice(this.opts.retention);
    for (const obj of toDelete) {
      if (!obj.Key) continue;
      await this.s3
        .send(
          new DeleteObjectCommand({
            Bucket: this.opts.bucket,
            Key: obj.Key,
          }),
        )
        .catch(() => {
          /* best-effort */
        });
    }
    return Math.min(sorted.length, this.opts.retention);
  }
}

function isoDate(d: Date): string {
  // UTC YYYY-MM-DD — one snapshot per calendar day irrespective of timezone.
  return d.toISOString().slice(0, 10);
}

/**
 * Disabled placeholder returned when env does not provide S3 credentials or
 * the operator explicitly turned the feature off. Lets callers ask for a
 * status without branching on `| undefined`.
 */
export function createDisabledVaultBackupStatus(
  reason: string,
): VaultBackupStatus {
  return {
    enabled: false,
    bucket: '',
    prefix: '',
    retention: 0,
    intervalHours: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    lastError: reason,
    objectsKept: null,
  };
}
