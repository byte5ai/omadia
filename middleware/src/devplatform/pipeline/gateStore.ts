import type { Pool } from 'pg';

import { parseIsoDurationMs } from '../../conductor/runExecutor.js';

/**
 * Epic #470 W2 — the durable human gate (`dev_job_gates`), spec §5.
 *
 * Modelled on `conductor_awaits`, and copying exactly the parts that make that
 * machinery safe:
 *   - idempotent open via the partial unique index (`WHERE status='waiting'`), so
 *     a crash-and-retry of the clarify→await_human transition never opens a
 *     duplicate gate;
 *   - resolution as a compare-and-swap (`WHERE id=$ AND status='waiting'`), so
 *     two concurrent resolvers race safely — one 200, one 409;
 *   - a deadline worker (`listDue` + atomic claim) that expires overdue gates;
 *   - the resolver identity recorded in the audit trail.
 *
 * Holder authorization is NOT here — it lives at the route, resolved LIVE against
 * roleStore at resolve time (a moved baton must re-target). This store only knows
 * the principal the gate was opened for.
 */

export interface GateQuestion {
  id: string;
  text: string;
}

export interface GateAnswer {
  questionId: string;
  text: string;
}

export type GatePrincipalKind = 'user' | 'role';
export type GateStatus = 'waiting' | 'resolved' | 'rejected' | 'expired' | 'cancelled';

export interface DevJobGate {
  id: string;
  jobId: string;
  planArtifactId: string | null;
  planSha256: string | null;
  baseSha: string | null;
  questions: GateQuestion[];
  principalKind: GatePrincipalKind;
  principalRef: string;
  status: GateStatus;
  answers: GateAnswer[] | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  deadlineAt: string | null;
  createdAt: string;
}

export interface OpenGateInput {
  jobId: string;
  planArtifactId?: string | null;
  planSha256?: string | null;
  baseSha?: string | null;
  questions: GateQuestion[];
  principalKind: GatePrincipalKind;
  principalRef: string;
  /** ISO-8601 duration (e.g. `P7D`) from the repo; parsed against `now`. */
  deadlineIso?: string | null;
}

interface GateRow {
  id: string;
  job_id: string;
  plan_artifact_id: string | null;
  plan_sha256: string | null;
  base_sha: string | null;
  questions: unknown;
  principal_kind: GatePrincipalKind;
  principal_ref: string;
  status: GateStatus;
  answers: unknown;
  resolved_by: string | null;
  resolved_at: Date | null;
  deadline_at: Date | null;
  created_at: Date;
}

function toGate(r: GateRow): DevJobGate {
  return {
    id: r.id,
    jobId: r.job_id,
    planArtifactId: r.plan_artifact_id,
    planSha256: r.plan_sha256,
    baseSha: r.base_sha,
    questions: Array.isArray(r.questions) ? (r.questions as GateQuestion[]) : [],
    principalKind: r.principal_kind,
    principalRef: r.principal_ref,
    status: r.status,
    answers: Array.isArray(r.answers) ? (r.answers as GateAnswer[]) : null,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    deadlineAt: r.deadline_at ? r.deadline_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

const COLS =
  'id, job_id, plan_artifact_id, plan_sha256, base_sha, questions, principal_kind, ' +
  'principal_ref, status, answers, resolved_by, resolved_at, deadline_at, created_at';

const DEFAULT_DEADLINE_ISO = 'P7D';

export class DevJobGateStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Open a gate for a job. Idempotent: a second open while one is already waiting
   * returns the EXISTING gate (ON CONFLICT DO NOTHING against the partial unique
   * index, then re-read), never a duplicate and never an error.
   */
  async open(input: OpenGateInput): Promise<DevJobGate> {
    const ms = parseIsoDurationMs(input.deadlineIso ?? DEFAULT_DEADLINE_ISO) ?? parseIsoDurationMs(DEFAULT_DEADLINE_ISO)!;
    const deadlineAt = new Date(this.now() + ms);
    const inserted = await this.pool.query<GateRow>(
      `INSERT INTO dev_job_gates
         (job_id, plan_artifact_id, plan_sha256, base_sha, questions, principal_kind, principal_ref, deadline_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (job_id) WHERE status = 'waiting' DO NOTHING
       RETURNING ${COLS}`,
      [
        input.jobId,
        input.planArtifactId ?? null,
        input.planSha256 ?? null,
        input.baseSha ?? null,
        JSON.stringify(input.questions),
        input.principalKind,
        input.principalRef,
        deadlineAt,
      ],
    );
    if (inserted.rows[0]) return toGate(inserted.rows[0]);
    // A waiting gate already existed — return it.
    const existing = await this.pool.query<GateRow>(
      `SELECT ${COLS} FROM dev_job_gates WHERE job_id = $1 AND status = 'waiting'`,
      [input.jobId],
    );
    if (!existing.rows[0]) {
      throw new Error(`gate open for ${input.jobId} inserted nothing and found no waiting gate`);
    }
    return toGate(existing.rows[0]);
  }

  async get(gateId: string): Promise<DevJobGate | null> {
    const r = await this.pool.query<GateRow>(`SELECT ${COLS} FROM dev_job_gates WHERE id = $1`, [gateId]);
    return r.rows[0] ? toGate(r.rows[0]) : null;
  }

  async listWaiting(): Promise<DevJobGate[]> {
    const r = await this.pool.query<GateRow>(
      `SELECT ${COLS} FROM dev_job_gates WHERE status = 'waiting' ORDER BY created_at`,
    );
    return r.rows.map(toGate);
  }

  /**
   * Resolve a gate. Compare-and-swap: only a WAITING gate flips, so a second
   * concurrent resolver gets rowCount 0 and this returns null → the route maps
   * that to 409 `gate_not_pending`. `resolvedBy` is the canonical responder sub.
   */
  async resolve(
    gateId: string,
    approved: boolean,
    resolvedBy: string,
    answers?: GateAnswer[],
  ): Promise<DevJobGate | null> {
    const r = await this.pool.query<GateRow>(
      `UPDATE dev_job_gates
          SET status = $2, answers = $3::jsonb, resolved_by = $4, resolved_at = now()
        WHERE id = $1 AND status = 'waiting'
        RETURNING ${COLS}`,
      [gateId, approved ? 'resolved' : 'rejected', answers ? JSON.stringify(answers) : null, resolvedBy],
    );
    return r.rows[0] ? toGate(r.rows[0]) : null;
  }

  /** Cancel a job's waiting gate (job cancelled by another path). CAS, best-effort. */
  async cancelForJob(jobId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_job_gates SET status = 'cancelled', resolved_at = now()
        WHERE job_id = $1 AND status = 'waiting'`,
      [jobId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Waiting gates past their deadline — the deadline worker's scan. */
  async listDue(): Promise<DevJobGate[]> {
    const r = await this.pool.query<GateRow>(
      `SELECT ${COLS} FROM dev_job_gates
        WHERE status = 'waiting' AND deadline_at IS NOT NULL AND deadline_at <= to_timestamp($1)`,
      [this.now() / 1000],
    );
    return r.rows.map(toGate);
  }

  /**
   * Atomically claim-and-expire one overdue gate. CAS on `waiting`, so two
   * workers never both expire the same gate. Returns the expired gate, or null if
   * another worker won the race.
   */
  async expire(gateId: string): Promise<DevJobGate | null> {
    const r = await this.pool.query<GateRow>(
      `UPDATE dev_job_gates SET status = 'expired', resolved_at = now()
        WHERE id = $1 AND status = 'waiting'
        RETURNING ${COLS}`,
      [gateId],
    );
    return r.rows[0] ? toGate(r.rows[0]) : null;
  }
}
