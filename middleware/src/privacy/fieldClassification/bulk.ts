/**
 * Field classification — bulk accept of the open suggestions (admin).
 *
 * GET  /bulk/preview?status=suggested&tool=&scope=&ids=
 *        what a confirm with the same parameters would write:
 *        `{ count, limit, byReason: { known_non_personal, haiku }, byTool,
 *        items: [{ id, toolName, scope, fieldPath, entry, reasonCode }] }`
 * POST /bulk/confirm   `{ ids }` or `{ filter: { status?, tool?, scope? } }`
 *        (at most one; neither = every open suggestion). Every candidate is
 *        re-validated against the LIVE classification: only status exactly
 *        `suggested` with a formable entry is applied. ONE config write under
 *        the plugin lock, a batch row, decision `confirm` with the batch id
 *        and one audit row per field. At most `BULK_CONFIRM_LIMIT` per call;
 *        the rest is reported as `remaining`.
 *        → `{ batchId, applied: [{ id, toolName, scope, fieldPath, entry }],
 *           skipped: [{ id, reason }], remaining }`
 * GET  /bulk/latest    `{ batch: { id, createdAt, actorEmail, count } | null }`
 * POST /bulk/:batchId/undo   only the latest batch not undone yet (409
 *        `not_latest_batch` / `already_undone`): removes exactly the entries
 *        it wrote that are still listed and still owned by its decision
 *        (others skipped `not_present` / `not_owned`; `stale` when its decision
 *        changed between the removal and the decision write), decision `revert`.
 *        Every decision write here is compare-and-set over the decision read.
 *        → `{ batchId, reverted: [{ id, entry }], skipped: [{ id, reason }] }`
 */

import type { Request, Response, Router } from 'express';
import { z } from 'zod';

import { auditActorFromRequest, type AdminAuditLog } from '../../auth/adminAuditLog.js';
import { ConfigEditConflict, type NonPersonalFieldsEditor } from './configEditor.js';
import {
  appendConfigEntry,
  configCoverage,
  configEntryOf,
  fieldAuditTarget,
  isValidFieldIdentity,
  removeConfigEntry,
  type FieldReason,
  type FieldStatus,
  type ModelVerdictSummary,
} from './engine.js';
import { cachedVerdicts, liveStatus } from './live.js';
import type { CandidateDecision, FieldCandidate, FieldClassificationStore } from './store.js';

export const BULK_CONFIRM_LIMIT = 500;
const MAX_IDS = 5000;
const AUDIT_ACTION = 'privacy.field_classification';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BulkSkipReason =
  | 'not_suggested'
  | 'person_model'
  | 'detector_hit'
  | 'conflict'
  | 'no_scope'
  | 'invalid_field'
  | 'already_covered'
  | 'stale';

export type BulkReasonCode = 'known_non_personal' | 'haiku';

export interface BulkRouteContext {
  readonly store: FieldClassificationStore;
  readonly editor: NonPersonalFieldsEditor;
  readonly rawConfig: () => string | undefined;
  readonly listable: (filter?: { toolName?: string }) => Promise<FieldCandidate[]>;
  readonly recordAudit: (entry: Parameters<AdminAuditLog['record']>[0]) => Promise<void>;
  readonly now: () => Date;
}

const filterSchema = z
  .object({
    status: z.literal('suggested').optional(),
    tool: z.string().min(1).max(200).optional(),
    scope: z.string().min(1).max(200).optional(),
  })
  .strict();

const confirmSchema = z
  .object({
    ids: z.array(z.string().regex(UUID_RE)).min(1).max(MAX_IDS).optional(),
    filter: filterSchema.optional(),
  })
  .strict()
  .refine((b) => b.ids === undefined || b.filter === undefined, {
    message: 'at most one of ids and filter',
  });

const previewQuerySchema = z.object({
  status: z.literal('suggested').optional(),
  tool: z.string().min(1).max(200).optional(),
  scope: z.string().min(1).max(200).optional(),
  ids: z.string().max(MAX_IDS * 37).optional(),
});

interface Selection {
  readonly ids?: readonly string[];
  readonly tool?: string;
  readonly scope?: string;
}

interface Eligible {
  readonly candidate: FieldCandidate;
  readonly entry: string;
  readonly reasonCode: BulkReasonCode;
}

interface Validation {
  readonly eligible: Eligible[];
  readonly skipped: { id: string; reason: BulkSkipReason }[];
}

/** Why a live status other than `suggested` is skipped. */
function skipReasonOf(status: FieldStatus, reasons: readonly FieldReason[]): BulkSkipReason {
  if (status === 'confirmed' || status === 'confirmed_conflict' || status === 'auto_approved') {
    return 'already_covered';
  }
  const codes = new Set(reasons.map((r) => r.code));
  if (codes.has('person_model')) return 'person_model';
  if (codes.has('identity_hit') || codes.has('name_hit') || codes.has('name_near_miss')) {
    return 'detector_hit';
  }
  if (codes.has('conflicting_targets')) return 'conflict';
  if (codes.has('no_scope')) return 'no_scope';
  return 'not_suggested';
}

function reasonCodeOf(reasons: readonly FieldReason[]): BulkReasonCode {
  return reasons.some((r) => r.code === 'known_non_personal') ? 'known_non_personal' : 'haiku';
}

/** Re-validate the selected candidates against the live classification. */
async function validate(ctx: BulkRouteContext, selection: Selection): Promise<Validation> {
  const all = await ctx.listable(selection.tool !== undefined ? { toolName: selection.tool } : {});
  const verdicts: Map<string, ModelVerdictSummary> = await cachedVerdicts(ctx.store, all, ctx.now());
  const config = ctx.rawConfig();
  const skipped: { id: string; reason: BulkSkipReason }[] = [];
  let candidates: FieldCandidate[];
  if (selection.ids !== undefined) {
    const byId = new Map(all.map((c) => [c.id, c]));
    candidates = [];
    for (const id of new Set(selection.ids)) {
      const c = byId.get(id) ?? (await ctx.store.get(id));
      if (c === undefined) skipped.push({ id, reason: 'stale' });
      else candidates.push(c);
    }
  } else {
    candidates = all.filter((c) => selection.scope === undefined || c.scope === selection.scope);
  }
  const eligible: Eligible[] = [];
  for (const c of candidates) {
    if (!isValidFieldIdentity(c)) {
      skipped.push({ id: c.id, reason: 'invalid_field' });
      continue;
    }
    const shown = liveStatus(c, config, verdicts);
    if (shown.status !== 'suggested') {
      // A filter selects the open suggestions; only explicit ids report why
      // the others are skipped.
      if (selection.ids !== undefined) skipped.push({ id: c.id, reason: skipReasonOf(shown.status, shown.reasons) });
      continue;
    }
    eligible.push({ candidate: c, entry: configEntryOf(c), reasonCode: reasonCodeOf(shown.reasons) });
  }
  return { eligible, skipped };
}

function itemOf(e: Eligible): { id: string; toolName: string; scope: string; fieldPath: string; entry: string } {
  return {
    id: e.candidate.id,
    toolName: e.candidate.toolName,
    scope: e.candidate.scope,
    fieldPath: e.candidate.fieldPath,
    entry: e.entry,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendFailure(res: Response, err: unknown, label: string, code: string): void {
  if (err instanceof ConfigEditConflict) {
    res.status(409).json(err.body);
    return;
  }
  console.error(`[privacy-fields] ${label} failed:`, errorText(err));
  res.status(500).json({ error: code });
}

export function registerBulkRoutes(router: Router, ctx: BulkRouteContext): void {
  router.get('/bulk/preview', async (req: Request, res: Response) => {
    const parsed = previewQuerySchema.safeParse(req.query);
    const ids = parsed.success ? parsed.data.ids?.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
    if (!parsed.success || (ids !== undefined && ids.some((id) => !UUID_RE.test(id)))) {
      res.status(400).json({ error: 'invalid_query' });
      return;
    }
    try {
      const { eligible } = await validate(ctx, {
        ...(ids !== undefined ? { ids } : {}),
        ...(parsed.data.tool !== undefined ? { tool: parsed.data.tool } : {}),
        ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
      });
      const byReason: Record<BulkReasonCode, number> = { known_non_personal: 0, haiku: 0 };
      const byTool: Record<string, number> = {};
      for (const e of eligible) {
        byReason[e.reasonCode] += 1;
        byTool[e.candidate.toolName] = (byTool[e.candidate.toolName] ?? 0) + 1;
      }
      res.json({
        count: eligible.length,
        limit: BULK_CONFIRM_LIMIT,
        byReason,
        byTool,
        items: eligible.map((e) => ({ ...itemOf(e), reasonCode: e.reasonCode })),
      });
    } catch (err) {
      sendFailure(res, err, 'bulk preview', 'field_classification_query_failed');
    }
  });

  router.post('/bulk/confirm', async (req: Request, res: Response) => {
    const parsed = confirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input', detail: parsed.error.issues });
      return;
    }
    const { ids, filter } = parsed.data;
    try {
      const validation = await validate(ctx, {
        ...(ids !== undefined ? { ids } : {}),
        ...(filter?.tool !== undefined ? { tool: filter.tool } : {}),
        ...(filter?.scope !== undefined ? { scope: filter.scope } : {}),
      });
      const skipped = [...validation.skipped];
      const selected = validation.eligible.slice(0, BULK_CONFIRM_LIMIT);
      const remaining = validation.eligible.length - selected.length;
      const added: Eligible[] = [];
      const change = await ctx.editor.edit((before) => {
        let next = before;
        for (const e of selected) {
          // Covered meanwhile (another admin, a recompute): not this batch's.
          if (configCoverage(next, e.candidate).covered) {
            skipped.push({ id: e.candidate.id, reason: 'already_covered' });
            continue;
          }
          next = appendConfigEntry(next, e.candidate);
          added.push(e);
        }
        return next;
      });
      if (added.length === 0) {
        res.json({ batchId: null, applied: [], skipped, remaining });
        return;
      }

      const actor = auditActorFromRequest(req);
      let batchId: string;
      try {
        batchId = await ctx.store.createBulkBatch({
          actorId: actor.id ?? null,
          actorEmail: actor.email ?? null,
          entries: added.map((e) => ({ candidateId: e.candidate.id, entry: e.entry })),
        });
      } catch (err) {
        // No entry without the batch that can undo it.
        await ctx.editor
          .edit((before) => added.reduce((next, e) => removeConfigEntry(next, e.candidate), before))
          .catch((undoErr: unknown) => {
            console.error('[privacy-fields] bulk rollback failed:', errorText(undoErr));
          });
        throw err;
      }

      const at = ctx.now().toISOString();
      const applied: ReturnType<typeof itemOf>[] = [];
      const failed: Eligible[] = [];
      for (const e of added) {
        const decision: CandidateDecision = {
          action: 'confirm',
          fingerprint: e.candidate.fingerprint,
          byId: actor.id ?? null,
          byEmail: actor.email ?? null,
          at,
          batchId,
        };
        let saved = false;
        try {
          // Compare-and-set over the decision the validation read: a
          // recompute or another admin deciding meanwhile wins.
          saved = await ctx.store.saveDecision(e.candidate.id, decision, 'confirmed', {
            decision: e.candidate.decision,
            fingerprint: e.candidate.fingerprint,
          });
        } catch (err) {
          console.error('[privacy-fields] bulk decision write failed:', errorText(err));
        }
        if (!saved) {
          failed.push(e);
          skipped.push({ id: e.candidate.id, reason: 'stale' });
          continue;
        }
        applied.push(itemOf(e));
        await ctx.recordAudit({
          actor,
          action: AUDIT_ACTION,
          target: fieldAuditTarget(e.candidate),
          before: { status: 'suggested' },
          after: { decision: 'confirm', status: 'confirmed', batchId, entry: e.entry, plugin: change.guardId },
        });
      }
      if (failed.length > 0) {
        await ctx.editor
          .edit((before) => failed.reduce((next, e) => removeConfigEntry(next, e.candidate), before))
          .catch((err: unknown) => {
            console.error('[privacy-fields] bulk rollback failed:', errorText(err));
          });
      }
      res.json({ batchId, applied, skipped, remaining });
    } catch (err) {
      sendFailure(res, err, 'bulk confirm', 'field_classification_bulk_failed');
    }
  });

  router.get('/bulk/latest', async (_req: Request, res: Response) => {
    try {
      const batch = await ctx.store.latestOpenBulkBatch();
      res.json({
        batch:
          batch !== undefined
            ? {
                id: batch.id,
                createdAt: batch.createdAt,
                actorEmail: batch.actorEmail,
                count: batch.entries.length,
              }
            : null,
      });
    } catch (err) {
      sendFailure(res, err, 'bulk latest', 'field_classification_query_failed');
    }
  });

  router.post('/bulk/:batchId/undo', async (req: Request, res: Response) => {
    const batchId = String(req.params['batchId'] ?? '');
    if (!UUID_RE.test(batchId)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    try {
      const batch = await ctx.store.getBulkBatch(batchId);
      if (batch === undefined) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (batch.undoneAt !== null) {
        res.status(409).json({ error: 'already_undone' });
        return;
      }
      const latest = await ctx.store.latestOpenBulkBatch();
      if (latest?.id !== batchId) {
        res.status(409).json({ error: 'not_latest_batch' });
        return;
      }
      await undoBatch(ctx, req, res, batch.id, batch.entries);
    } catch (err) {
      sendFailure(res, err, 'bulk undo', 'field_classification_bulk_undo_failed');
    }
  });
}

async function undoBatch(
  ctx: BulkRouteContext,
  req: Request,
  res: Response,
  batchId: string,
  entries: readonly { candidateId: string; entry: string }[],
): Promise<void> {
  const skipped: { id: string; reason: 'not_present' | 'not_owned' | 'stale' }[] = [];
  const removed: { candidate: FieldCandidate; entry: string }[] = [];
  // Ownership is read inside the plugin lock, right before the removal.
  const change = await ctx.editor.edit(async (before) => {
    let next = before;
    for (const e of entries) {
      const candidate = await ctx.store.get(e.candidateId);
      // Still this batch's: its confirm, not a later decision.
      if (
        candidate === undefined ||
        candidate.decision?.action !== 'confirm' ||
        candidate.decision.batchId !== batchId
      ) {
        skipped.push({ id: e.candidateId, reason: 'not_owned' });
        continue;
      }
      if (!configCoverage(next, candidate).exact) {
        skipped.push({ id: candidate.id, reason: 'not_present' });
        continue;
      }
      next = removeConfigEntry(next, candidate);
      removed.push({ candidate, entry: e.entry });
    }
    return next;
  });
  const actor = auditActorFromRequest(req);
  if (!(await ctx.store.markBulkBatchUndone(batchId, actor.email ?? actor.id ?? 'admin', ctx.now()))) {
    // A concurrent undo got there first; its removals already ran.
    res.status(409).json({ error: 'already_undone' });
    return;
  }
  const at = ctx.now().toISOString();
  const verdicts = await cachedVerdicts(
    ctx.store,
    removed.map((r) => r.candidate),
    ctx.now(),
  );
  const reverted: { id: string; entry: string }[] = [];
  for (const { candidate, entry } of removed) {
    const decision: CandidateDecision = {
      action: 'revert',
      fingerprint: candidate.fingerprint,
      byId: actor.id ?? null,
      byEmail: actor.email ?? null,
      at,
      batchId,
    };
    const shown = liveStatus(candidate, change.after, verdicts, decision);
    let saved = false;
    try {
      saved = await ctx.store.saveDecision(candidate.id, decision, shown.status, {
        decision: candidate.decision,
        fingerprint: candidate.fingerprint,
      });
    } catch (err) {
      // The entry is gone (fail safe: masked); only the decision row is missing.
      console.error('[privacy-fields] bulk undo decision write failed:', errorText(err));
    }
    if (!saved) {
      // Decided anew meanwhile: that decision stands (the entry is out —
      // fail safe, masked).
      skipped.push({ id: candidate.id, reason: 'stale' });
      continue;
    }
    reverted.push({ id: candidate.id, entry });
    await ctx.recordAudit({
      actor,
      action: AUDIT_ACTION,
      target: fieldAuditTarget(candidate),
      before: { status: 'confirmed' },
      after: {
        decision: 'revert',
        status: shown.status,
        batchId,
        entry,
        plugin: change.guardId,
      },
    });
  }
  res.json({ batchId, reverted, skipped });
}
