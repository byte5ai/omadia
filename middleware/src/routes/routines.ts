import { Router } from 'express';
import type { Request, Response } from 'express';
import { isDeepStrictEqual } from 'node:util';

import { readOperatorAuditState, recordOperatorAudit, type AdminAuditLog } from '../auth/adminAuditLog.js';
import { requireUuidParam } from '../http/uuidParam.js';
import { nextCronRun, UTC_ZONE } from '../scheduler/zonedCron.js';
import {
  parseRoutineOutputTemplate,
  type RoutineOutputTemplate,
} from '../plugins/routines/routineOutputTemplate.js';
import { RoutineRunInProgressError } from '../plugins/routines/routineRunControl.js';
import {
  RoutineNotFoundError,
  type RoutineActorScope,
  type RoutineRunner,
} from '../plugins/routines/routineRunner.js';
import type {
  RoutineRun,
  RoutineRunsStore,
} from '../plugins/routines/routineRunsStore.js';
import type { Routine, RoutineStore } from '../plugins/routines/routineStore.js';
import { renderRoutineTemplate } from '../plugins/routines/routineTemplateRenderer.js';

/**
 * #1025 — every mutation on this router runs cross-tenant, which is a
 * decision rather than an omission: the whole router sits behind
 * behind `requireAuth`, and an operator managing one tenant's routines
 * from the Operator UI is the feature. Named once so the intent is
 * greppable and a future non-operator route cannot inherit it by accident.
 */
const OPERATOR_SCOPE: RoutineActorScope = { kind: 'operator' };

export interface RoutinesRouterDeps {
  store: RoutineStore;
  runsStore: RoutineRunsStore;
  runner: RoutineRunner;
  audit?: Pick<AdminAuditLog, 'record'>;
  log?: (msg: string) => void;
}

export interface RoutineDto {
  id: string;
  tenant: string;
  userId: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  status: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  /** Phase C.7 — server-side output template, null = legacy LLM-renders path. */
  outputTemplate: RoutineOutputTemplate | null;
  /** #1748 — a run is in flight on this instance; "run now" answers 409 meanwhile. */
  running: boolean;
  /** #1744 — the agent that runs the routine (null = bound to none). */
  agentSlug: string | null;
  /** #1744 / #1745 — why no agent may run it (disabled, deleted, replaced, unbound), else null. */
  agentProblem: string | null;
  /** #1743 / #1749 — the zone the cron pattern is evaluated in (ADR 0240). */
  timeZone: string;
  /** #1749 — the next run (ISO), null when paused, past its deadline or never again. */
  nextRunAt: string | null;
  /** #1749 / #2082 — the routine's deadline (ISO), null until first scheduled. */
  until: string | null;
}

export interface PreviewRoutineTemplateRequest {
  template: unknown;
  /** Synthetic raw tool results keyed by tool name. Values are
   *  forwarded to the renderer as-is; strings get JSON-parsed on demand. */
  rawToolResults?: Record<string, unknown>;
  /** Synthetic narrative-slot values keyed by slot id. */
  slots?: Record<string, string>;
  /** Optional Intl locale override. */
  locale?: string;
  /** Optional ISO currency code override. */
  currency?: string;
}

export type PreviewRoutineTemplateResponse =
  | {
      ok: true;
      format: 'markdown';
      text: string;
      /** #1761 — data sections whose source could not give rows. */
      warnings: readonly string[];
    }
  | {
      ok: true;
      format: 'adaptive-card';
      items: readonly unknown[];
      warnings: readonly string[];
    }
  | { ok: false; reason: string };

export interface ListRoutinesResponse {
  routines: RoutineDto[];
  count: number;
}

export interface RoutineResponse {
  routine: RoutineDto;
}

/**
 * Lightweight run summary for the per-routine list view. Excludes the
 * `runTrace` blob — that lives behind the single-run detail endpoint
 * because the listing path can have 50 rows and a full trace per row
 * would balloon the response.
 */
export interface RoutineRunSummaryDto {
  id: string;
  routineId: string;
  trigger: 'cron' | 'catchup' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'timeout' | 'cancelled' | 'silent';
  errorMessage: string | null;
  iterations: number | null;
  toolCalls: number | null;
  /** #1776 — metered model cost in USD; null = not metered. */
  costUsd: number | null;
}

export interface RoutineRunDetailDto extends RoutineRunSummaryDto {
  prompt: string;
  answer: string | null;
  /** Full agentic trace as stored in JSONB. Generic JSON-tree on the UI. */
  runTrace: unknown | null;
}

export interface ListRoutineRunsResponse {
  runs: RoutineRunSummaryDto[];
  count: number;
  /** #1776 — what all recorded runs of the routine cost (USD). */
  totalCostUsd: number;
}

export interface RoutineRunResponse {
  run: RoutineRunDetailDto;
}

function toRunSummary(r: RoutineRun): RoutineRunSummaryDto {
  return {
    id: r.id,
    routineId: r.routineId,
    trigger: r.trigger,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    durationMs: r.durationMs,
    status: r.status,
    errorMessage: r.errorMessage,
    iterations: r.iterations,
    toolCalls: r.toolCalls,
    costUsd: r.costUsd,
  };
}

function toRunDetail(r: RoutineRun): RoutineRunDetailDto {
  return {
    ...toRunSummary(r),
    prompt: r.prompt,
    answer: r.answer,
    runTrace: r.runTrace,
  };
}

function toDto(r: Routine, running = false, agentProblem: string | undefined = undefined): RoutineDto {
  return {
    id: r.id,
    tenant: r.tenant,
    userId: r.userId,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    channel: r.channel,
    status: r.status,
    timeoutMs: r.timeoutMs,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastRunStatus: r.lastRunStatus,
    lastRunError: r.lastRunError,
    outputTemplate: r.outputTemplate,
    running,
    agentSlug: r.agentSlug ?? null,
    agentProblem: agentProblem ?? null,
    timeZone: r.timezone ?? UTC_ZONE,
    nextRunAt: nextRunAtOf(r),
    until: r.until ? r.until.toISOString() : null,
  };
}

/** #1749 — the routine's next run in its zone, if it runs again before its deadline. */
function nextRunAtOf(r: Routine, now: Date = new Date()): string | null {
  if (r.status !== 'active') return null;
  try {
    const next = nextCronRun(r.cron, r.timezone ?? UTC_ZONE, now);
    if (!next || (r.until && next > r.until)) return null;
    return next.toISOString();
  } catch {
    return null;
  }
}

/**
 * Operator-grade observability + lifecycle endpoint for routines.
 *
 * Today the create flow is intentionally absent: a new routine only makes
 * sense with a real channel-native delivery handle (Teams
 * `conversationReference`), which only the inbound channel adapter
 * captures. Until the chat-create flow is wired, operators can list,
 * pause/resume, and delete — covering every observability and incident-
 * response need without producing orphan rows.
 *
 * Routes are mounted under `/api/v1/routines` and gated by `requireAuth`.
 *   GET    /                  → list all routines (cross-tenant)
 *   PATCH  /:id/status        → body `{status: 'active' | 'paused'}`
 *   POST   /:id/trigger       → fire one manual run (records as `manual` in routine_runs);
 *                               503 `routines.chat_unavailable` while no chat agent is published
 *   GET    /:id/runs          → list per-routine run history (last 50 by default)
 *   GET    /:id/runs/:runId   → single run with full agentic trace (call-stack viewer)
 *   DELETE /:id               → permanent (cascades into routine_runs)
 */
export function createRoutinesRouter(deps: RoutinesRouterDeps): Router {
  const router = Router();
  // #1398 — `routines.id` and `routine_runs.id` are uuid columns. A malformed
  // id names no row; answer the route's 404 instead of letting Postgres 22P02
  // become a 500 that echoes the database error.
  router.param('id', requireUuidParam('routines.not_found'));
  router.param('runId', requireUuidParam('routines.run_not_found'));
  const log = deps.log ?? ((m) => console.log(m));

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Operator view: include paused rows alongside active.
      // Cross-tenant list is acceptable here because the route is behind
      // requireAuth — any valid operator session, see OPERATOR_SCOPE.
      const rows = await deps.store.listAll();
      const body: ListRoutinesResponse = {
        routines: rows.map((r) => toDto(r, deps.runner.isRunning(r.id), deps.runner.agentProblemOf(r))),
        count: rows.length,
      };
      res.json(body);
    } catch (err) {
      log(`[routines/route] GET / failed: ${errMsg(err)}`);
      res.status(500).json({ code: 'routines.list_failed', message: errMsg(err) });
    }
  });

  router.patch(
    '/:id/status',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const status = (req.body as { status?: string } | undefined)?.status;
      if (status !== 'active' && status !== 'paused') {
        res.status(400).json({
          code: 'routines.bad_status',
          message: "body.status must be 'active' or 'paused'",
        });
        return;
      }
      try {
        // #1025 — cross-tenant on purpose, same rationale as the list
        // above: this router sits behind requireAuth. The
        // scope is stated rather than omitted so it reads as a decision.
        const previous = deps.audit ? await readOperatorAuditState(() => deps.store.get(id)) : undefined;
        const updated =
          status === 'paused'
            ? await deps.runner.pauseRoutine(id, OPERATOR_SCOPE)
            : await deps.runner.resumeRoutine(id, OPERATOR_SCOPE);
        await recordOperatorAudit(deps.audit, req, {
          action: status === 'paused' ? 'routine.pause' : 'routine.resume',
          target: `routine:${id}`,
          before: previous === 'unknown' ? previous : previous && routineAuditStatus(previous),
          after: routineAuditStatus(updated),
        });
        const body: RoutineResponse = { routine: toDto(updated, deps.runner.isRunning(updated.id), deps.runner.agentProblemOf(updated)) };
        res.json(body);
      } catch (err) {
        if (err instanceof RoutineNotFoundError) {
          res.status(404).json({ code: 'routines.not_found', message: err.message });
          return;
        }
        log(`[routines/route] PATCH /:id/status failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.update_failed',
          message: errMsg(err),
        });
      }
    },
  );

  router.post(
    '/:id/trigger',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      // Validate that the routine exists BEFORE returning — otherwise
      // a bad id silently fire-and-forgets. The store.get is a fast
      // index lookup so a 404 still resolves under the proxy budget.
      let routine;
      try {
        routine = await deps.runner.peekRoutine(id);
      } catch (err) {
        log(`[routines/route] POST /:id/trigger peek failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.trigger_failed',
          message: errMsg(err),
        });
        return;
      }
      if (!routine) {
        res
          .status(404)
          .json({ code: 'routines.not_found', message: `routine '${id}' not found` });
        return;
      }
      // #1071 — a paused routine (by the user, or auto-paused because its
      // web chat was deleted) is not run: answer 409 synchronously instead of
      // a 202 for a run that would only be skipped.
      if (routine.status !== 'active') {
        res.status(409).json({
          code: 'routines.not_active',
          message: `routine '${id}' is ${routine.status}; resume it before triggering it`,
        });
        return;
      }
      // Interactive path gets a synchronous 503 while no chat agent is
      // published (LLM key not configured) instead of a 202 whose run is
      // guaranteed to fail in the background — the web-ui maps this code
      // to a "set the key in Settings" message. Cron fires keep recording
      // `error` runs so the misconfiguration stays visible in history.
      // #1748 — one run per routine: a second "run now" (or one while the
      // cron run is in flight) is refused instead of delivering twice.
      if (deps.runner.isRunning(id)) {
        res.status(409).json({
          code: 'routines.run_in_progress',
          message: new RoutineRunInProgressError(id).message,
        });
        return;
      }
      // #1744 — the routine's agent is gone, disabled or replaced: say which,
      // instead of accepting a run that records the same error.
      const agentProblem = deps.runner.agentProblemOf(routine);
      if (agentProblem !== undefined) {
        res.status(409).json({ code: 'routines.agent_unavailable', message: agentProblem });
        return;
      }
      // #2357 (ADR-0324) — the budget checks a scheduled firing gets.
      const budgetRefusal = await deps.runner.manualRunRefusal(id);
      if (budgetRefusal !== undefined) {
        res.status(409).json({ code: 'routines.budget_refused', message: budgetRefusal });
        return;
      }
      if (!deps.runner.chatAgentAvailable(routine.agentSlug ?? null)) {
        res.status(503).json({
          code: 'routines.chat_unavailable',
          message:
            'chat agent unavailable — the routine\'s orchestrator is gone, no standard orchestrator is set, or the LLM API key is not configured',
        });
        return;
      }
      // Fire-and-forget: the trigger run takes seconds (LLM call +
      // tool roundtrip + validator retry + Teams send). Holding the
      // HTTP connection open the whole way means web-ui proxies time
      // out with 500 even though the run succeeds and the Teams card
      // arrives via the proactive sender. Return 202 immediately;
      // the run's outcome is observable via `GET /:id/runs`.
      void deps.runner
        .triggerRoutineNow(id, OPERATOR_SCOPE)
        .catch((err: unknown) => {
          log(
            `[routines/route] background trigger run for ${id} failed: ${errMsg(err)}`,
          );
        });
      void recordOperatorAudit(deps.audit, req, {
        action: 'routine.trigger',
        target: `routine:${id}`,
        after: { ...routineAuditStatus(routine), trigger: 'manual', accepted: true },
      });
      const body: RoutineResponse = { routine: toDto(routine, true) };
      res.status(202).json(body);
    },
  );

  router.get(
    '/:id/runs',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const limitRaw = req.query['limit'];
      const limit =
        typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 50;
      // #1749 — load more: runs that started before this ISO instant.
      const beforeRaw = req.query['before'];
      const before = typeof beforeRaw === 'string' ? new Date(beforeRaw) : undefined;
      if (before !== undefined && Number.isNaN(before.getTime())) {
        res.status(400).json({ code: 'routines.invalid_before', message: "'before' must be an ISO date-time" });
        return;
      }
      try {
        // Ensure parent exists so a 404 differs from "exists with zero runs".
        const parent = await deps.store.get(id);
        if (!parent) {
          res.status(404).json({
            code: 'routines.not_found',
            message: `routine '${id}' not found`,
          });
          return;
        }
        const rows = await deps.runsStore.listForRoutine(
          id,
          Number.isFinite(limit) ? limit : 50,
          before,
        );
        const total = await deps.runsStore.totalCost(id);
        const body: ListRoutineRunsResponse = {
          runs: rows.map(toRunSummary),
          count: rows.length,
          totalCostUsd: total.costUsd,
        };
        res.json(body);
      } catch (err) {
        log(`[routines/route] GET /:id/runs failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.runs_list_failed',
          message: errMsg(err),
        });
      }
    },
  );

  router.get(
    '/:id/runs/:runId',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const runIdRaw = req.params['runId'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const runId = typeof runIdRaw === 'string' ? runIdRaw : '';
      try {
        const run = await deps.runsStore.get(runId);
        if (!run || run.routineId !== id) {
          res.status(404).json({
            code: 'routines.run_not_found',
            message: `run '${runId}' not found for routine '${id}'`,
          });
          return;
        }
        const body: RoutineRunResponse = { run: toRunDetail(run) };
        res.json(body);
      } catch (err) {
        log(`[routines/route] GET /:id/runs/:runId failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.run_detail_failed',
          message: errMsg(err),
        });
      }
    },
  );

  /**
   * Phase C.7 — Set or clear a routine's output_template. Body shape:
   *   `{ template: RoutineOutputTemplate | null }`
   * `null` reverts to the legacy LLM-renders path. Non-null payloads
   * are validated via `parseRoutineOutputTemplate`; invalid shapes
   * return 400 with the reason. Backward-compatible: routines that
   * predate this endpoint keep working without a template.
   */
  router.put(
    '/:id/template',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const body = req.body as { template?: unknown } | undefined;
      if (body === undefined || !('template' in body)) {
        res.status(400).json({
          code: 'routines.template_missing',
          message: "body must include a 'template' field (object or null)",
        });
        return;
      }
      let template: RoutineOutputTemplate | null;
      if (body.template === null) {
        template = null;
      } else {
        const parsed = parseRoutineOutputTemplate(body.template);
        if (!parsed.ok) {
          res.status(400).json({
            code: 'routines.template_invalid',
            message: parsed.reason,
          });
          return;
        }
        template = parsed.value;
      }
      try {
        const previous = deps.audit ? await readOperatorAuditState(() => deps.store.get(id)) : undefined;
        const updated = await deps.store.setOutputTemplate(id, template);
        if (!updated) {
          res.status(404).json({
            code: 'routines.not_found',
            message: `routine '${id}' not found`,
          });
          return;
        }
        await recordOperatorAudit(deps.audit, req, {
          action: 'routine.template_change',
          target: `routine:${id}`,
          before: previous === 'unknown' ? previous : previous && routineAuditTemplate(previous),
          after: {
            ...routineAuditTemplate(updated),
            contentChanged: previous === 'unknown'
              ? null
              : !isDeepStrictEqual(previous?.outputTemplate ?? null, updated.outputTemplate),
          },
        });
        const out: RoutineResponse = { routine: toDto(updated) };
        res.json(out);
      } catch (err) {
        log(`[routines/route] PUT /:id/template failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.template_update_failed',
          message: errMsg(err),
        });
      }
    },
  );

  /**
   * Phase C.7 — Preview-render a template against operator-supplied
   * synthetic raw tool results + slot values. Stateless: never reads
   * or writes the routine row, so it works for new templates the
   * operator hasn't saved yet. Body shape: `PreviewRoutineTemplateRequest`.
   * Returns the renderer's union result verbatim so the UI can show
   * either the rendered markdown or the Adaptive Card body items.
   */
  router.post(
    '/preview-template',
    async (req: Request, res: Response): Promise<void> => {
      const body = req.body as PreviewRoutineTemplateRequest | undefined;
      if (body === undefined || body.template === undefined) {
        res.status(400).json({
          code: 'routines.template_missing',
          message: "body must include a 'template' field",
        });
        return;
      }
      const parsed = parseRoutineOutputTemplate(body.template);
      if (!parsed.ok) {
        res.status(400).json({
          code: 'routines.template_invalid',
          message: parsed.reason,
        });
        return;
      }
      const rawToolResults = new Map<string, unknown>(
        Object.entries(body.rawToolResults ?? {}),
      );
      const slots = body.slots ?? {};
      const result = renderRoutineTemplate({
        template: parsed.value,
        rawToolResults,
        slots,
        ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
        ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
      });
      const response: PreviewRoutineTemplateResponse = result.ok
        ? result.format === 'markdown'
          ? { ok: true, format: 'markdown', text: result.text, warnings: result.warnings }
          : { ok: true, format: 'adaptive-card', items: result.items, warnings: result.warnings }
        : { ok: false, reason: result.reason };
      res.json(response);
    },
  );

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    try {
      // #1025 — cross-tenant by design on this router (see PATCH).
      const previous = deps.audit ? await readOperatorAuditState(() => deps.store.get(id)) : undefined;
      const ok = await deps.runner.deleteRoutine(id, OPERATOR_SCOPE);
      if (!ok) {
        res.status(404).json({
          code: 'routines.not_found',
          message: `routine '${id}' not found`,
        });
        return;
      }
      await recordOperatorAudit(deps.audit, req, {
        action: 'routine.delete',
        target: `routine:${id}`,
        before: previous === 'unknown' ? previous : previous && {
          ...routineAuditStatus(previous),
          name: previous.name,
          cron: previous.cron,
          channel: previous.channel,
        },
      });
      res.status(204).end();
    } catch (err) {
      log(`[routines/route] DELETE /:id failed: ${errMsg(err)}`);
      res.status(500).json({
        code: 'routines.delete_failed',
        message: errMsg(err),
      });
    }
  });

  return router;
}

function routineAuditStatus(routine: Routine) {
  return { tenant: routine.tenant, owner_id: routine.userId, status: routine.status };
}

function routineAuditTemplate(routine: Routine) {
  const template = routine.outputTemplate;
  return {
    owner_id: routine.userId,
    tenant: routine.tenant,
    template: template ? {
      format: template.format,
      sections: template.sections.map(({ kind }) => kind),
    } : null,
  };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
