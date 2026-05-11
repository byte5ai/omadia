import type { DraftStore } from './draftStore.js';

/**
 * Soft-capped draft quota per admin user. The cap is a guard-rail against
 * runaway disk usage on the shared Fly volume — not an abuse defence: the
 * builder is admin-only and all admins are whitelisted by email. If we ever
 * start hitting the cap in normal use, bump the default here rather than
 * invent per-user overrides.
 *
 * Soft-deleted drafts do not count against the cap; installed drafts do
 * until the user explicitly removes them (otherwise an admin could install
 * 50 agents, still hit the wall when building the 51st, and have to go
 * archive tombstones to move forward).
 */

export interface QuotaSnapshot {
  used: number;
  cap: number;
  warnAt: number;
  remaining: number;
  /** `true` once the user is within warn-zone (≥ `warnAt`). */
  warning: boolean;
  /** `true` once the cap has been reached — further `create` calls reject. */
  exceeded: boolean;
}

export interface DraftQuotaOptions {
  store: DraftStore;
  /** Hard cap — `create` rejects at or above this. Default: 50. */
  cap?: number;
  /** Soft threshold for the dashboard warning badge. Default: 40. */
  warnAt?: number;
}

const DEFAULT_CAP = 50;
const DEFAULT_WARN_AT = 40;

export class DraftQuota {
  private readonly store: DraftStore;
  private readonly cap: number;
  private readonly warnAt: number;

  constructor(opts: DraftQuotaOptions) {
    this.store = opts.store;
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.warnAt = opts.warnAt ?? DEFAULT_WARN_AT;
    if (this.warnAt > this.cap) {
      throw new Error(
        `DraftQuota: warnAt (${String(this.warnAt)}) must be ≤ cap (${String(this.cap)})`,
      );
    }
  }

  async snapshot(userEmail: string): Promise<QuotaSnapshot> {
    const used = await this.store.count(userEmail, { scope: 'active' });
    return {
      used,
      cap: this.cap,
      warnAt: this.warnAt,
      remaining: Math.max(0, this.cap - used),
      warning: used >= this.warnAt && used < this.cap,
      exceeded: used >= this.cap,
    };
  }

  /**
   * Throws `QuotaExceededError` if the user is at or above the cap. Called
   * from the `POST /drafts` route before allocating a new row.
   */
  async assertCanCreate(userEmail: string): Promise<void> {
    const snap = await this.snapshot(userEmail);
    if (snap.exceeded) {
      throw new QuotaExceededError(snap);
    }
  }
}

export class QuotaExceededError extends Error {
  readonly code = 'quota.exceeded';

  constructor(public readonly snapshot: QuotaSnapshot) {
    super(
      `Draft-Quota erreicht (${String(snapshot.used)} / ${String(snapshot.cap)}). ` +
        'Lösche bestehende Drafts, bevor du einen neuen anlegst.',
    );
    this.name = 'QuotaExceededError';
  }
}
