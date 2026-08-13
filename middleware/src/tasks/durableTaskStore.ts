/**
 * Issue #560 — the DURABLE {@link TaskStore}, the follow-up the seam was
 * extracted for.
 *
 * `InMemoryTaskStore` backs the seam in a per-process `Map`, so every
 * long-running task dies on restart and `<tool>_status` then answers
 * "not found". This is the Postgres-backed twin: the same claim/lease semantics,
 * persisted to the `tasks` / `task_events` tables (migration 0034), so a task
 * survives a restart and can be re-driven by the resume driver
 * (`@omadia/orchestrator`'s `startTaskResumeDriver`).
 *
 * ## Faithful to the reference
 *
 * Every method mirrors `InMemoryTaskStore` behaviour exactly — that is what the
 * shared conformance suite (`test/tasks/taskStoreConformance.ts`) pins, running
 * the identical assertions against both stores. Where the in-memory store leans
 * on Node's single-threadedness for atomicity, this leans on
 * `FOR UPDATE SKIP LOCKED` and lease-fenced `WHERE` clauses, which is the same
 * guarantee across processes.
 *
 * ## Fencing
 *
 * Every lease-bound write is a guarded `UPDATE ... WHERE id = $1 AND
 * claimed_by = $lease AND status NOT IN (terminal)`. Zero rows updated collapses
 * the three "you no longer own this" cases — gone, already terminal, or claimed
 * by someone else — into one {@link TaskLeaseLostError}, exactly as the
 * in-memory `fenced()` does. The `status NOT IN (terminal)` half is the
 * load-bearing terminal-immutability guard the reaper relies on (it preserves
 * `claimed_by` on a force-fail, so a zombie worker still presents a matching
 * lease and only this guard stops it overwriting the outcome).
 *
 * The two UNFENCED writers — `reapOrphans` (the orphan sweep) and `provideInput`
 * (the resume transition) — act on rows that hold no lease by construction, and
 * are status-guarded instead. See the seam contract on {@link TaskStore}.
 */

import type { Pool } from 'pg';

import {
  TASK_LEASE_UUID_RE,
  TaskLeaseLostError,
  type NewTaskInput,
  type TaskDescriptor,
  type TaskEventRecord,
  type TaskListFilter,
  type TaskReapOptions,
  type TaskReapResult,
  type TaskStore,
  type TerminalTaskPatch,
} from '@omadia/orchestrator';

/** Descriptor columns, in one place so every read projects identically. `input`
 *  is fetched separately — only `claimNextPending` hands it back. */
const TASK_COLS =
  'id, kind, status, phase, claimed_by, claimed_at, last_heartbeat_at, ' +
  'result, error, created_by, created_at, updated_at, ended_at';

/** Terminal set, matching {@link TERMINAL_TASK_STATUSES}. Inlined because it is
 *  the `status NOT IN (...)` fence guard, evaluated on every lease-bound write. */
const TERMINAL_SET_SQL = `'completed','failed'`;

/** Upper bound on `eventTail` — a status poll wants "what is it doing", not the
 *  whole log. Mirrors the developer-job adapter's cap. */
const MAX_EVENT_TAIL = 2000;

type Row = Record<string, unknown>;

const isoN = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);

function toDescriptor(r: Row): TaskDescriptor {
  return {
    id: r['id'] as string,
    kind: r['kind'] as string,
    status: r['status'] as TaskDescriptor['status'],
    phase: r['phase'] as string,
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
    endedAt: isoN(r['ended_at']),
    claimedBy: (r['claimed_by'] as string | null) ?? null,
    lastHeartbeatAt: isoN(r['last_heartbeat_at']),
    result: (r['result'] as string | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    createdBy: (r['created_by'] as string | null) ?? null,
  };
}

export class DurableTaskStore implements TaskStore {
  constructor(private readonly pool: Pool) {}

  async create(input: NewTaskInput): Promise<TaskDescriptor> {
    const r = await this.pool.query<Row>(
      `INSERT INTO tasks (kind, phase, input, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING ${TASK_COLS}`,
      [
        input.kind,
        input.phase ?? 'queued',
        // `?? null` so an absent input becomes a JSON `null` (valid jsonb), never
        // SQL NULL — the column is NOT NULL.
        JSON.stringify(input.input ?? null),
        input.createdBy ?? null,
      ],
    );
    return toDescriptor(r.rows[0] as Row);
  }

  async get(id: string): Promise<TaskDescriptor | null> {
    const r = await this.pool.query<Row>(
      `SELECT ${TASK_COLS} FROM tasks WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? toDescriptor(r.rows[0]) : null;
  }

  async list(filter: TaskListFilter = {}): Promise<readonly TaskDescriptor[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.createdBy !== undefined) {
      params.push(filter.createdBy);
      where.push(`created_by = $${params.length}`);
    }
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), 500);
    params.push(limit);
    const r = await this.pool.query<Row>(
      `SELECT ${TASK_COLS} FROM tasks
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toDescriptor);
  }

  async eventTail(id: string, limit: number): Promise<readonly TaskEventRecord[]> {
    const n = Math.min(Math.max(1, Math.trunc(limit)), MAX_EVENT_TAIL);
    // Newest n, then reversed to oldest-first — the seam's tail order.
    const r = await this.pool.query<Row>(
      `SELECT seq, ts, type, message FROM task_events
        WHERE task_id = $1 ORDER BY seq DESC LIMIT $2`,
      [id, n],
    );
    return r.rows
      .map((row) => ({
        seq: Number(row['seq']),
        ts: iso(row['ts']),
        type: row['type'] as string,
        message: row['message'] as string,
      }))
      .reverse();
  }

  async claimNextPending(
    lease: string,
    kind?: string,
    taskId?: string,
  ): Promise<{ descriptor: TaskDescriptor; input: unknown } | null> {
    if (!TASK_LEASE_UUID_RE.test(lease)) {
      throw new TypeError(`claimNextPending: lease must be a UUID (got '${lease}')`);
    }
    // Unlike the developer-job adapter, this store CAN honour the task-id hint: its
    // claim is its own `SELECT ... FOR UPDATE SKIP LOCKED`, so narrowing it to one
    // id is exact. `kind` and `id` are optional predicates; the row is stamped
    // with the lease in the same statement, so two workers never cross claims.
    const preds = [`status = 'working'`, 'claimed_by IS NULL'];
    const params: unknown[] = [lease];
    if (kind !== undefined) {
      params.push(kind);
      preds.push(`kind = $${params.length}`);
    }
    if (taskId !== undefined) {
      params.push(taskId);
      preds.push(`id = $${params.length}`);
    }
    const r = await this.pool.query<Row>(
      `UPDATE tasks
          SET claimed_by = $1, claimed_at = now(), last_heartbeat_at = now(),
              updated_at = now()
        WHERE id = (
          SELECT id FROM tasks
           WHERE ${preds.join(' AND ')}
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING ${TASK_COLS}, input`,
      params,
    );
    const row = r.rows[0];
    if (!row) return null;
    return { descriptor: toDescriptor(row), input: row['input'] };
  }

  async heartbeat(id: string, lease: string): Promise<void> {
    await this.fencedUpdate(
      `UPDATE tasks SET last_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [id, lease],
      id,
    );
  }

  async setPhase(id: string, lease: string, phase: string): Promise<void> {
    await this.fencedUpdate(
      `UPDATE tasks SET phase = $3, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [id, lease, phase],
      id,
    );
  }

  async appendEvents(
    id: string,
    lease: string,
    events: readonly { type: string; message: string }[],
  ): Promise<void> {
    if (events.length === 0) return;
    // One statement, atomic: fence, compute the per-task seq, insert the batch,
    // and bump the heartbeat — all gated on the fence passing. `WITH ORDINALITY`
    // makes `ord` start at 1, so the first event of an empty task is `seq = 1`,
    // matching the in-memory store. Safe against the seq PK because a task has a
    // single lease holder, so appends to one task are serial.
    const r = await this.pool.query<Row>(
      `WITH fence AS (
         SELECT id FROM tasks
          WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})
       ),
       maxseq AS (
         SELECT coalesce(max(seq), 0) AS m FROM task_events WHERE task_id = $1
       ),
       ins AS (
         INSERT INTO task_events (task_id, seq, type, message)
         SELECT $1, maxseq.m + t.ord, t.type, t.message
           FROM maxseq, unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(type, message, ord)
          WHERE EXISTS (SELECT 1 FROM fence)
         RETURNING 1
       ),
       touch AS (
         UPDATE tasks SET last_heartbeat_at = now(), updated_at = now()
          WHERE id = $1 AND EXISTS (SELECT 1 FROM fence)
       )
       SELECT (SELECT count(*) FROM fence) AS fenced`,
      [id, lease, events.map((e) => e.type), events.map((e) => e.message)],
    );
    if (Number((r.rows[0] as Row)['fenced']) === 0) throw new TaskLeaseLostError(id);
  }

  async finish(
    id: string,
    lease: string,
    patch: TerminalTaskPatch,
  ): Promise<TaskDescriptor> {
    const r = await this.pool.query<Row>(
      `UPDATE tasks
          SET status = $3,
              phase = coalesce($4, phase),
              result = $5,
              error = $6,
              ended_at = now(),
              updated_at = now(),
              claimed_by = NULL
        WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})
        RETURNING ${TASK_COLS}`,
      [id, lease, patch.status, patch.phase ?? null, patch.result ?? null, patch.error ?? null],
    );
    if (!r.rows[0]) throw new TaskLeaseLostError(id);
    return toDescriptor(r.rows[0]);
  }

  async requireInput(
    id: string,
    lease: string,
    phase?: string,
  ): Promise<TaskDescriptor> {
    // Releases the lease — the task now waits on a human, so the claim loop must
    // be free to re-claim it once `provideInput` un-parks it.
    const r = await this.pool.query<Row>(
      `UPDATE tasks
          SET status = 'input_required',
              phase = coalesce($3, phase),
              claimed_by = NULL,
              updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})
        RETURNING ${TASK_COLS}`,
      [id, lease, phase ?? null],
    );
    if (!r.rows[0]) throw new TaskLeaseLostError(id);
    return toDescriptor(r.rows[0]);
  }

  async provideInput(id: string, input: unknown): Promise<TaskDescriptor> {
    // The resume transition (criterion 5): input_required → working, UNFENCED and
    // status-guarded. Replaces the stored input so the re-driven executor sees the
    // human's answer instead of re-running to the same gate.
    //
    // `last_heartbeat_at = now()` resets the liveness clock. The parked row froze
    // its heartbeat at the pre-park claim, so without this reset the reaper's
    // worker-window (`coalesce(last_heartbeat_at, created_at) < staleCutoff`)
    // judges the freshly resumed task by a heartbeat that predates the human wait
    // and force-fails it as "abandoned" before the resume driver re-claims it. A
    // resumed row is as live as a freshly claimed one — full window from NOW.
    const r = await this.pool.query<Row>(
      `UPDATE tasks
          SET status = 'working', input = $2::jsonb,
              last_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'input_required'
        RETURNING ${TASK_COLS}`,
      [id, JSON.stringify(input ?? null)],
    );
    if (r.rows[0]) return toDescriptor(r.rows[0]);
    // 0 rows: distinguish idempotent double-resume (already `working`) from a
    // missing/terminal task, matching the in-memory store.
    const current = await this.get(id);
    if (!current) throw new TaskLeaseLostError(id);
    if (current.status === 'working') return current;
    throw new TaskLeaseLostError(id);
  }

  async reapOrphans(opts: TaskReapOptions): Promise<TaskReapResult> {
    if (!Number.isFinite(opts.staleAfterMs) || opts.staleAfterMs <= 0) {
      throw new TypeError('reapOrphans: staleAfterMs must be a positive number');
    }
    if (!Number.isFinite(opts.purgeTerminalAfterMs) || opts.purgeTerminalAfterMs <= 0) {
      throw new TypeError('reapOrphans: purgeTerminalAfterMs must be a positive number');
    }
    if (
      opts.parkedStaleAfterMs !== undefined &&
      (!Number.isFinite(opts.parkedStaleAfterMs) || opts.parkedStaleAfterMs <= 0)
    ) {
      throw new TypeError(
        'reapOrphans: parkedStaleAfterMs, when given, must be a positive number',
      );
    }
    const now = opts.now ?? new Date();
    const staleCutoff = new Date(now.getTime() - opts.staleAfterMs).toISOString();
    const purgeCutoff = new Date(now.getTime() - opts.purgeTerminalAfterMs).toISOString();

    // Abandoned live tasks. `claimed_by` is deliberately PRESERVED (not cleared),
    // so a zombie worker waking up later still presents a matching lease and the
    // terminal guard in the fenced writes — not the lease check — is what rejects
    // it. "Last sign of life" is the heartbeat, else creation, so a never-claimed
    // orphan is reaped too. `input_required` is excluded — a parked task ages on
    // its own window, below.
    const staleWorking = await this.pool.query(
      `UPDATE tasks
          SET status = 'failed',
              error = 'task abandoned: no worker heartbeat within the orphan window '
                      || '(worker crashed, restarted, or was never started)',
              ended_at = $1, updated_at = $1
        WHERE status = 'working'
          AND coalesce(last_heartbeat_at, created_at) < $2`,
      [now.toISOString(), staleCutoff],
    );
    let staleFailed = staleWorking.rowCount ?? 0;

    // Parked tasks only when the operator opted in, aged from `updated_at` (when
    // they parked), with a distinct error so an operator can tell them apart.
    if (opts.parkedStaleAfterMs !== undefined) {
      const parkedCutoff = new Date(
        now.getTime() - opts.parkedStaleAfterMs,
      ).toISOString();
      const staleParked = await this.pool.query(
        `UPDATE tasks
            SET status = 'failed',
                error = 'task expired: no human answered the input request within '
                        || 'the parked-task window',
                ended_at = $1, updated_at = $1
          WHERE status = 'input_required' AND updated_at < $2`,
        [now.toISOString(), parkedCutoff],
      );
      staleFailed += staleParked.rowCount ?? 0;
    }

    const purge = await this.pool.query(
      `DELETE FROM tasks
        WHERE status IN (${TERMINAL_SET_SQL})
          AND coalesce(ended_at, updated_at) < $1`,
      [purgeCutoff],
    );
    return { staleFailed, purged: purge.rowCount ?? 0 };
  }

  /** Run a lease-fenced UPDATE; 0 rows ⇒ {@link TaskLeaseLostError}. Shared by the
   *  void-returning fenced writes. */
  private async fencedUpdate(
    sql: string,
    params: unknown[],
    id: string,
  ): Promise<void> {
    const r = await this.pool.query(sql, params);
    if ((r.rowCount ?? 0) === 0) throw new TaskLeaseLostError(id);
  }
}
