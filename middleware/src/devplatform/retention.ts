/**
 * Epic #470 W5 — dev-platform data lifecycle / retention (spec §7).
 *
 * Two problems bound the unbounded growth of a job's audit trail:
 *
 *  1. Event volume. Every runner emits a stream of `heartbeat`/`log` telemetry
 *     that is worthless a month later, alongside audit-grade events (`status`,
 *     `tool`, `gate`, `token`, `approval`, `egress`, `phase`) that a compliance
 *     review may need for a year. A single retention window would either keep the
 *     noise too long or discard the audit trail too soon, so the runner prunes in
 *     TWO tiers: low-value telemetry at `DEV_PLATFORM_EVENT_RETENTION_DAYS`
 *     (default 30), everything at the outer `DEV_PLATFORM_AUDIT_RETENTION_DAYS`
 *     bound (default 365).
 *
 *  2. Terminal-job accumulation. `purgeTerminalJobs` deletes finished jobs older
 *     than a window; the `ON DELETE CASCADE` on `dev_job_events` /
 *     `dev_job_artifacts` (0022) removes their children in the same statement.
 *
 * The per-job event cap (`DEV_JOB_MAX_EVENTS`) and the artifact ceiling
 * (`DEV_ARTIFACT_MAX_BYTES`) are the WRITE-path halves of the same policy: the cap
 * lives in `devJobStore.appendEvents` (it reuses {@link LOW_VALUE_EVENT_TYPES}
 * from here), and the ceiling is {@link applyArtifactCeiling}, invoked by
 * `devJobArtifactStore.addArtifact`.
 *
 * This module imports only from `types.ts` (no `devJobStore` import) so the
 * write-path files can depend on it without a cycle.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { TERMINAL_DEV_JOB_STATUSES, type DevJobEventType } from './types.js';

const MS_PER_DAY = 86_400_000;

/**
 * Low-value telemetry: pruned at the SHORT `eventRetentionDays` tier, and the
 * event types the per-job cap drops on the append path. Everything NOT in this
 * set is audit-grade — kept until the outer `auditRetentionDays` bound and never
 * dropped by the cap.
 */
export const LOW_VALUE_EVENT_TYPES = [
  'heartbeat',
  'log',
] as const satisfies readonly DevJobEventType[];

const LOW_VALUE_SET: ReadonlySet<string> = new Set(LOW_VALUE_EVENT_TYPES);

/** Is this a low-value telemetry event (pruned early / dropped past the cap)? */
export function isLowValueEventType(type: string): boolean {
  return LOW_VALUE_SET.has(type);
}

/** Retention windows, in days. Sourced from config; both must be positive. */
export interface RetentionConfig {
  /** `heartbeat`/`log` older than this are pruned (default 30). */
  eventRetentionDays: number;
  /** ANY event older than this is pruned regardless of type (default 365). */
  auditRetentionDays: number;
}

/** What one retention pass deleted. */
export interface RetentionResult {
  /** Low-value telemetry rows deleted at the short tier. */
  lowValueEventsDeleted: number;
  /** Rows deleted at the outer audit bound (any type). */
  expiredEventsDeleted: number;
}

/** UTC cutoff `days` before `now`. Computed in JS (not `now()`) so tests can
 *  drive the clock deterministically. */
function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * The daily data-lifecycle runner. Stateless over an injected `Pool`; the
 * scheduler registration is a one-liner in `index.ts` (see below), kept out of
 * here so the runner stays unit-testable against a real Postgres.
 *
 * Scheduler wiring (the one line I do NOT add here, per W5 scope):
 *   jobScheduler.register('dev-platform', {
 *     name: 'dev-retention',
 *     schedule: { cron: '17 3 * * *' },        // daily, off-peak
 *     overlap: 'skip',
 *     timeoutMs: 10 * 60_000,
 *   }, () => new DevRetentionRunner(pool, {
 *     eventRetentionDays: config.DEV_PLATFORM_EVENT_RETENTION_DAYS,
 *     auditRetentionDays: config.DEV_PLATFORM_AUDIT_RETENTION_DAYS,
 *   }).run().then(() => undefined));
 */
export class DevRetentionRunner {
  constructor(
    private readonly pool: Pool,
    private readonly config: RetentionConfig,
  ) {
    if (!Number.isInteger(config.eventRetentionDays) || config.eventRetentionDays <= 0) {
      throw new TypeError('DevRetentionRunner: eventRetentionDays must be a positive integer');
    }
    if (!Number.isInteger(config.auditRetentionDays) || config.auditRetentionDays <= 0) {
      throw new TypeError('DevRetentionRunner: auditRetentionDays must be a positive integer');
    }
  }

  /** One full pass: prune the short tier, then the outer audit bound. */
  async run(now: Date = new Date()): Promise<RetentionResult> {
    const lowValueEventsDeleted = await this.pruneLowValueEvents(now);
    const expiredEventsDeleted = await this.pruneExpiredEvents(now);
    return { lowValueEventsDeleted, expiredEventsDeleted };
  }

  /**
   * Tier 1: delete `heartbeat`/`log` events older than `eventRetentionDays`.
   * Audit-grade events of the same age are untouched — they wait for the outer
   * bound below.
   */
  async pruneLowValueEvents(now: Date = new Date()): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM dev_job_events WHERE type = ANY($1::text[]) AND ts < $2`,
      [[...LOW_VALUE_EVENT_TYPES], cutoff(now, this.config.eventRetentionDays)],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Tier 2 (outer bound): delete ANY event older than `auditRetentionDays`,
   * regardless of type — even audit-grade events do not live forever.
   */
  async pruneExpiredEvents(now: Date = new Date()): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM dev_job_events WHERE ts < $1`,
      [cutoff(now, this.config.auditRetentionDays)],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Terminal-job purge: delete `dev_jobs` rows that are terminal AND ended before
   * the cutoff. `ON DELETE CASCADE` (0022) removes their events + artifacts in the
   * same statement. Active (non-terminal) jobs and in-window terminal jobs are
   * left untouched. Returns the number of jobs purged.
   */
  async purgeTerminalJobs(
    olderThanDays: number,
    now: Date = new Date(),
  ): Promise<number> {
    if (!Number.isInteger(olderThanDays) || olderThanDays <= 0) {
      throw new TypeError('purgeTerminalJobs: olderThanDays must be a positive integer');
    }
    const r = await this.pool.query(
      `DELETE FROM dev_jobs
        WHERE status = ANY($1::text[]) AND ended_at IS NOT NULL AND ended_at < $2`,
      [[...TERMINAL_DEV_JOB_STATUSES], cutoff(now, olderThanDays)],
    );
    return r.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Artifact ceiling (spec §7) — the write-path half applied by addArtifact.
// ---------------------------------------------------------------------------

/**
 * Object-storage seam. Injected only where offload is wired; ABSENT in W5 (no S3
 * client is invented here). When present, oversized artifact content is offloaded
 * and the inline row becomes a pointer.
 */
export interface ObjectStore {
  /** Store `content` under an opaque key and return a durable reference. */
  put(key: string, content: string): Promise<{ ref: string; bytes: number }>;
}

/** Options threading the ceiling into `addArtifact`. */
export interface ArtifactCeilingOptions {
  /** Max inline bytes. `<= 0` disables the ceiling (backward-compatible). */
  maxBytes: number;
  /** Optional offload backend; absent ⇒ oversized content is MARKED, not stored. */
  objectStore?: ObjectStore;
}

/** Result of applying the ceiling: the (possibly rewritten) row content + meta. */
export interface ArtifactCeilingResult {
  content: string;
  meta: Record<string, unknown>;
}

/**
 * Enforce {@link ArtifactCeilingOptions.maxBytes} on an artifact's content.
 *
 * Within the ceiling ⇒ returned unchanged. Over the ceiling:
 *  - with an {@link ObjectStore}: content is offloaded and the inline row becomes
 *    a short pointer, `meta.offloaded = true` with the `objectRef`.
 *  - without one: the content is REFUSED inline — replaced by a bounded marker,
 *    `meta.oversized = true` with the original size. Nothing unbounded is ever
 *    written inline.
 *
 * Per spec §7 a 200 MiB diff is a policy `gate` long before it is a storage
 * problem; the realistic oversized case here is a large transcript, so marking
 * (rather than throwing and failing the job) is the graceful default.
 */
export async function applyArtifactCeiling(
  jobId: string,
  kind: string,
  content: string,
  meta: Record<string, unknown>,
  opts: ArtifactCeilingOptions,
): Promise<ArtifactCeilingResult> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (opts.maxBytes <= 0 || bytes <= opts.maxBytes) {
    return { content, meta };
  }

  if (opts.objectStore) {
    const key = `dev-jobs/${jobId}/${kind}/${randomUUID()}`;
    const { ref } = await opts.objectStore.put(key, content);
    return {
      content: `[offloaded to object storage: ${ref} (${String(bytes)} bytes)]`,
      meta: {
        ...meta,
        offloaded: true,
        objectRef: ref,
        originalBytes: bytes,
        ceilingBytes: opts.maxBytes,
      },
    };
  }

  // TODO(W5+): wire an ObjectStore backend so oversized transcripts remain
  // retrievable instead of being reduced to this marker.
  return {
    content:
      `[artifact omitted: ${String(bytes)} bytes exceeds the ` +
      `${String(opts.maxBytes)}-byte ceiling and no object store is configured]`,
    meta: {
      ...meta,
      oversized: true,
      originalBytes: bytes,
      ceilingBytes: opts.maxBytes,
    },
  };
}
