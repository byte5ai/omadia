import type { Router, Request, Response } from 'express';

import type { DraftStore } from '../plugins/builder/draftStore.js';
import { BuilderModelRegistry } from '../plugins/builder/modelRegistry.js';
import {
  IllegalSpecState,
  JsonPatchSchema,
  applyJsonPatchesRaw,
  type JsonPatch,
} from '../plugins/builder/specPatcher.js';
import type { SpecEventBus } from '../plugins/builder/specEventBus.js';
import type { RebuildScheduler } from '../plugins/builder/tools/index.js';
import type {
  AgentSpecSkeleton,
  BuilderModelId,
} from '../plugins/builder/types.js';

/**
 * Builder inline-edit routes (Phase B.4-4).
 *
 *   PATCH /drafts/:id/spec   → body { patches: JsonPatch[] } applies, emits,
 *                               schedules rebuild
 *   PATCH /drafts/:id/slot   → body { slotKey, source } overwrites slot,
 *                               emits, schedules rebuild
 *   PATCH /drafts/:id/model  → body { codegenModel?, previewModel? } updates
 *                               model selection (NO rebuild — model switch is
 *                               a no-op for already-built artifacts)
 *
 * All three endpoints are owner-scoped: a draft belonging to user A is
 * unreachable for user B (DraftStore queries always filter by `user_email`,
 * so `load(...)` returns `null` for cross-user lookups).
 *
 * The single-endpoint PATCH /drafts/:id (in builder.ts) remains for the
 * dashboard's draft-name rename — these endpoints are the structured-edit
 * surface the workspace UI uses while a draft is open.
 */

export interface BuilderEditDeps {
  draftStore: DraftStore;
  bus: SpecEventBus;
  rebuildScheduler: RebuildScheduler;
}

export function registerBuilderEditRoutes(
  router: Router,
  deps: BuilderEditDeps,
): void {
  // ── PATCH /drafts/:id/spec ──────────────────────────────────────────────
  router.patch('/drafts/:id/spec', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const draftId = readId(req);
    if (!draftId) return sendJson(res, 400, { code: 'builder.invalid_id', message: 'missing :id' });

    const body = (req.body ?? {}) as { patches?: unknown };
    if (!Array.isArray(body.patches) || body.patches.length === 0) {
      return sendJson(res, 400, {
        code: 'builder.invalid_patches',
        message: 'patches must be a non-empty array',
      });
    }

    let patches: JsonPatch[];
    try {
      patches = body.patches.map((p) => JsonPatchSchema.parse(p));
    } catch (err) {
      return sendJson(res, 400, {
        code: 'builder.invalid_patches',
        message: err instanceof Error ? err.message : 'malformed patch',
      });
    }

    const draft = await deps.draftStore.load(email, draftId);
    if (!draft) {
      return sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
    }

    let nextSpec: AgentSpecSkeleton;
    try {
      nextSpec = applyJsonPatchesRaw(draft.spec, patches) as AgentSpecSkeleton;
    } catch (err) {
      const message = err instanceof IllegalSpecState ? err.message : String(err);
      return sendJson(res, 400, { code: 'builder.illegal_patch', message });
    }

    const updated = await deps.draftStore.update(email, draftId, { spec: nextSpec });
    deps.bus.emit(draftId, { type: 'spec_patch', patches, cause: 'user' });
    deps.rebuildScheduler.schedule(email, draftId);

    res.json({ draft: updated });
  });

  // ── PATCH /drafts/:id/slot ──────────────────────────────────────────────
  router.patch('/drafts/:id/slot', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const draftId = readId(req);
    if (!draftId) return sendJson(res, 400, { code: 'builder.invalid_id', message: 'missing :id' });

    const body = (req.body ?? {}) as { slotKey?: unknown; source?: unknown };
    if (typeof body.slotKey !== 'string' || !/^[a-z][a-z0-9-]*$/.test(body.slotKey)) {
      return sendJson(res, 400, {
        code: 'builder.invalid_slot_key',
        message: 'slotKey must be kebab-case (lowercase, digits, dashes; start with a letter)',
      });
    }
    if (typeof body.source !== 'string') {
      return sendJson(res, 400, {
        code: 'builder.invalid_slot_source',
        message: 'source must be a string',
      });
    }
    const slotKey = body.slotKey;
    const source = body.source;

    const draft = await deps.draftStore.load(email, draftId);
    if (!draft) {
      return sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
    }

    const nextSlots: Record<string, string> = { ...draft.slots, [slotKey]: source };
    const updated = await deps.draftStore.update(email, draftId, { slots: nextSlots });
    deps.bus.emit(draftId, {
      type: 'slot_patch',
      slotKey,
      source,
      cause: 'user',
    });
    deps.rebuildScheduler.schedule(email, draftId);

    res.json({ draft: updated });
  });

  // ── PATCH /drafts/:id/model ─────────────────────────────────────────────
  router.patch('/drafts/:id/model', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const draftId = readId(req);
    if (!draftId) return sendJson(res, 400, { code: 'builder.invalid_id', message: 'missing :id' });

    const body = (req.body ?? {}) as {
      codegenModel?: unknown;
      previewModel?: unknown;
    };

    const patch: { codegenModel?: BuilderModelId; previewModel?: BuilderModelId } = {};

    if (body.codegenModel !== undefined) {
      if (!isValidModel(body.codegenModel)) {
        return sendJson(res, 400, {
          code: 'builder.invalid_model',
          message: 'codegenModel muss einer von haiku|sonnet|opus sein',
        });
      }
      patch.codegenModel = body.codegenModel;
    }
    if (body.previewModel !== undefined) {
      if (!isValidModel(body.previewModel)) {
        return sendJson(res, 400, {
          code: 'builder.invalid_model',
          message: 'previewModel muss einer von haiku|sonnet|opus sein',
        });
      }
      patch.previewModel = body.previewModel;
    }
    if (patch.codegenModel === undefined && patch.previewModel === undefined) {
      return sendJson(res, 400, {
        code: 'builder.invalid_model',
        message: 'at least one of codegenModel or previewModel must be set',
      });
    }

    const updated = await deps.draftStore.update(email, draftId, patch);
    if (!updated) {
      return sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
    }

    // Model switch deliberately does NOT trigger a rebuild — codegen/preview
    // model selection is a runtime knob, the built artifact does not change.
    res.json({ draft: updated });
  });
}

// ---------------------------------------------------------------------------

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}

function isValidModel(value: unknown): value is BuilderModelId {
  return typeof value === 'string' && BuilderModelRegistry.has(value);
}
