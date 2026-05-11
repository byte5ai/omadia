import { Router } from 'express';
import type { Request, Response } from 'express';

import type { DraftStore, DraftListOptions } from '../plugins/builder/draftStore.js';
import { QuotaExceededError } from '../plugins/builder/draftQuota.js';
import type { DraftQuota } from '../plugins/builder/draftQuota.js';
import { BuilderModelRegistry } from '../plugins/builder/modelRegistry.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS } from '../platform/assets.js';
import {
  discoverTemplates,
  loadBoilerplate,
} from '../plugins/builder/boilerplateSource.js';
import { loadEntityVocabulary } from '../plugins/builder/entityVocabulary.js';
import type {
  BuilderModelId,
  DraftStatus,
} from '../plugins/builder/types.js';
import {
  registerBuilderPreviewRoutes,
  type BuilderPreviewDeps,
} from './builderPreview.js';
import {
  registerBuilderChatRoutes,
  type BuilderChatDeps,
} from './builderChat.js';
import {
  registerBuilderEditRoutes,
  type BuilderEditDeps,
} from './builderEdit.js';
import {
  registerBuilderEventsRoutes,
  type BuilderEventsDeps,
} from './builderEvents.js';
import {
  registerBuilderInstallRoutes,
  type BuilderInstallDeps,
} from './builderInstall.js';

/**
 * Builder REST surface — Phase B.0 scope.
 *
 * Provides the draft persistence + model-catalog endpoints the dashboard UI
 * needs to list, create, rename, and soft-delete agent-builder drafts.
 * SSE event stream, codegen, preview-chat and install-commit land in later
 * phases (B.2–B.5) and extend this same router.
 *
 * All endpoints require the admin session (mounted behind `requireAuth`).
 * Every query is scoped by `req.session.email` — a user can never read or
 * mutate another admin's drafts.
 *
 * Mounted at `/api/v1/builder`.
 */

export interface BuilderRouterDeps {
  store: DraftStore;
  quota: DraftQuota;
  /** Preview-runtime dependencies (B.3). When omitted, only the B.0 draft
   *  CRUD endpoints are mounted — preview/chat/turn etc. remain absent.
   *  Wired by `index.ts` once PreviewRuntime + cache + chat-service +
   *  build-pipeline have been instantiated. */
  preview?: BuilderPreviewDeps;
  /** Builder-chat dependencies (B.4-3). When omitted, the
   *  POST /drafts/:id/turn endpoint stays absent. Wired by `index.ts` once
   *  BuilderAgent has been instantiated. */
  chat?: BuilderChatDeps;
  /** Inline-edit dependencies (B.4-4). When omitted, the PATCH
   *  /drafts/:id/{spec,slot,model} endpoints stay absent. Wired by
   *  `index.ts` alongside the chat surface. */
  editing?: BuilderEditDeps;
  /** SSE event-bus stream (B.5-4). When omitted, the
   *  GET /drafts/:id/events endpoint stays absent. Wired by `index.ts`
   *  alongside the chat + edit surfaces — a single SpecEventBus instance
   *  is shared between BuilderAgent (agent-cause), the inline-edit
   *  endpoints (user-cause), and this fan-out. */
  events?: BuilderEventsDeps;
  /** Install-commit dependencies (B.6-1). When omitted, the
   *  POST /drafts/:id/install endpoint stays absent. Wired by `index.ts`
   *  with `{ draftStore, buildPipeline, packageUploadService }` — the same
   *  build-pipeline instance also drives preview rebuilds, so an install
   *  serializes naturally behind any pending preview build for the draft. */
  install?: BuilderInstallDeps;
}

export function createBuilderRouter(deps: BuilderRouterDeps): Router {
  const router = Router();

  // ── GET /drafts/:id/types ──────────────────────────────────────────────
  // Returns the per-template TypeScript surface (boilerplate `types.ts` +
  // `@omadia/plugin-api` `.d.ts` exports) as virtual lib files for
  // Monaco's `addExtraLib`. Cmd+Click + LSP-autocomplete on `PluginContext`,
  // `Toolkit` etc. without any client-side bundling. (B.6-11)
  router.get('/drafts/:id/types', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const draftId = requireId(req);
      const draft = await deps.store.load(email, draftId);
      if (!draft) {
        return res.status(404).json({
          code: 'builder.draft_not_found',
          message: `kein Draft mit id '${draftId}'`,
        });
      }
      const rawTemplate = (draft.spec as unknown as { template?: unknown })
        .template;
      const templateId =
        typeof rawTemplate === 'string' && rawTemplate.length > 0
          ? rawTemplate
          : 'agent-integration';
      const libs = await loadDraftLibs(templateId);
      res.json({ template: templateId, libs });
    } catch (err) {
      sendError(res, err, 'builder.types_failed');
    }
  });

  // ── GET /drafts/:id/template/slots ─────────────────────────────────────
  // Returns the template manifest's slot-defs for the draft's chosen
  // template. The Workspace uses this to show "Vom Template gefordert"
  // alongside the user's filled slots so the user can see at a glance
  // which required slots are still empty.
  router.get(
    '/drafts/:id/template/slots',
    async (req: Request, res: Response) => {
      try {
        const email = requireEmail(req);
        const draftId = req.params['id'];
        if (typeof draftId !== 'string' || draftId.length === 0) {
          return sendError(
            res,
            new Error('missing :id'),
            'builder.invalid_id',
          );
        }
        const draft = await deps.store.load(email, draftId);
        if (!draft) {
          return res.status(404).json({
            code: 'builder.draft_not_found',
            message: `kein Draft mit id '${draftId}'`,
          });
        }
        const rawTemplate = (draft.spec as unknown as { template?: unknown })
          .template;
        const templateId =
          typeof rawTemplate === 'string' && rawTemplate.length > 0
            ? rawTemplate
            : 'agent-integration';
        try {
          const bundle = await loadBoilerplate(templateId);
          res.json({
            template: templateId,
            slots: bundle.manifest.slots.map((s) => ({
              key: s.key,
              target_file: s.target_file,
              required: s.required,
              ...(s.description ? { description: s.description } : {}),
            })),
          });
        } catch (err) {
          res.status(404).json({
            code: 'builder.template_not_found',
            message:
              err instanceof Error
                ? err.message
                : `template '${templateId}' nicht ladbar`,
          });
        }
      } catch (err) {
        sendError(res, err, 'builder.template_slots_failed');
      }
    },
  );

  // ── GET /templates ──────────────────────────────────────────────────────
  // Static list of available codegen templates with id + description. The
  // Workspace Template-Switcher (B.6-9) uses this to populate the dropdown.
  // Description is read straight from each `template.yaml` so adding a new
  // boilerplate directory is enough — no code change.
  router.get('/templates', async (_req: Request, res: Response) => {
    try {
      const ids = await discoverTemplates();
      const templates = await Promise.all(
        ids.map(async (id) => {
          const bundle = await loadBoilerplate(id);
          return {
            id,
            description: bundle.manifest.description,
          };
        }),
      );
      res.json({ templates });
    } catch (err) {
      sendError(res, err, 'builder.templates_failed');
    }
  });

  // ── GET /entity-vocabulary ──────────────────────────────────────────────
  // Returns the parsed entity-registry projection used by the workspace
  // tool-authoring surface (B.11-4) for capability-vocabulary autocomplete
  // in tool-input-schema descriptions. Cached in-process; the registry
  // file is read only on first request per worker.
  router.get('/entity-vocabulary', async (_req: Request, res: Response) => {
    try {
      const entries = await loadEntityVocabulary();
      res.json({ entities: entries });
    } catch (err) {
      sendError(res, err, 'builder.entity_vocabulary_failed');
    }
  });

  // ── POST /drafts/:id/manifest-preview ──────────────────────────────────
  // Renders manifest.yaml as it would appear in the next codegen run, so
  // the Workspace ManifestDiffSidebar (B.11-9) can show the operator the
  // result of their form edits without having to trigger a full build.
  // Stays cheap because we only execute generate() and return a single
  // file; no zip, no fs writes.
  router.post(
    '/drafts/:id/manifest-preview',
    async (req: Request, res: Response) => {
      try {
        const email = requireEmail(req);
        const id = requireId(req);
        const draft = await deps.store.load(email, id);
        if (!draft) {
          res.status(404).json({
            code: 'builder.draft_not_found',
            message: `kein Draft mit id '${id}'`,
          });
          return;
        }
        const { renderManifestPreview } = await import(
          '../plugins/builder/manifestPreview.js'
        );
        const yaml = await renderManifestPreview(draft.spec);
        res.json({ manifest: yaml });
      } catch (err) {
        sendError(res, err, 'builder.manifest_preview_failed');
      }
    },
  );

  // ── GET /models ─────────────────────────────────────────────────────────
  router.get('/models', (_req: Request, res: Response) => {
    res.json({
      models: BuilderModelRegistry.list().map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        max_tokens: m.maxTokens,
      })),
      default: BuilderModelRegistry.default(),
    });
  });

  // ── GET /drafts ─────────────────────────────────────────────────────────
  router.get('/drafts', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const scope = parseScope(req.query['scope']);
      const status = parseStatus(req.query['status']);

      const opts: DraftListOptions = { scope };
      if (status) opts.status = status;

      const items = await deps.store.list(email, opts);
      const quota = await deps.quota.snapshot(email);
      res.json({ items, quota });
    } catch (err) {
      sendError(res, err, 'builder.list_failed');
    }
  });

  // ── POST /drafts ────────────────────────────────────────────────────────
  router.post('/drafts', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const body = (req.body ?? {}) as { name?: unknown };
      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, 200)
          : 'Neuer Agent';

      await deps.quota.assertCanCreate(email);
      const draft = await deps.store.create(email, name);
      res.status(201).json({ draft });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(409).json({
          code: err.code,
          message: err.message,
          quota: err.snapshot,
        });
        return;
      }
      sendError(res, err, 'builder.create_failed');
    }
  });

  // ── GET /drafts/:id ─────────────────────────────────────────────────────
  router.get('/drafts/:id', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const id = requireId(req);
      const draft = await deps.store.load(email, id);
      if (!draft) {
        res.status(404).json({
          code: 'builder.draft_not_found',
          message: `kein Draft mit id '${id}'`,
        });
        return;
      }
      res.json({ draft });
    } catch (err) {
      sendError(res, err, 'builder.load_failed');
    }
  });

  // ── PATCH /drafts/:id ───────────────────────────────────────────────────
  // Metadata-only patch (name, codegen_model, preview_model). Spec/slot
  // mutations come through dedicated endpoints in B.4.
  router.patch('/drafts/:id', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const id = requireId(req);
      const body = (req.body ?? {}) as {
        name?: unknown;
        codegen_model?: unknown;
        preview_model?: unknown;
      };

      const patch: Parameters<DraftStore['update']>[2] = {};

      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          res.status(400).json({
            code: 'builder.invalid_name',
            message: 'name muss ein nicht-leerer String sein',
          });
          return;
        }
        patch.name = body.name.trim().slice(0, 200);
      }

      if (body.codegen_model !== undefined) {
        if (!isValidModel(body.codegen_model)) {
          res.status(400).json({
            code: 'builder.invalid_model',
            message: `codegen_model muss einer von haiku|sonnet|opus sein`,
          });
          return;
        }
        patch.codegenModel = body.codegen_model;
      }

      if (body.preview_model !== undefined) {
        if (!isValidModel(body.preview_model)) {
          res.status(400).json({
            code: 'builder.invalid_model',
            message: `preview_model muss einer von haiku|sonnet|opus sein`,
          });
          return;
        }
        patch.previewModel = body.preview_model;
      }

      const draft = await deps.store.update(email, id, patch);
      if (!draft) {
        res.status(404).json({
          code: 'builder.draft_not_found',
          message: `kein Draft mit id '${id}'`,
        });
        return;
      }
      res.json({ draft });
    } catch (err) {
      sendError(res, err, 'builder.update_failed');
    }
  });

  // ── DELETE /drafts/:id ──────────────────────────────────────────────────
  router.delete('/drafts/:id', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const id = requireId(req);
      const ok = await deps.store.softDelete(email, id);
      if (!ok) {
        res.status(404).json({
          code: 'builder.draft_not_found',
          message: `kein Draft mit id '${id}'`,
        });
        return;
      }
      res.status(204).end();
    } catch (err) {
      sendError(res, err, 'builder.delete_failed');
    }
  });

  // ── POST /drafts/:id/restore ────────────────────────────────────────────
  router.post('/drafts/:id/restore', async (req: Request, res: Response) => {
    try {
      const email = requireEmail(req);
      const id = requireId(req);
      await deps.quota.assertCanCreate(email);
      const ok = await deps.store.restore(email, id);
      if (!ok) {
        res.status(404).json({
          code: 'builder.draft_not_found',
          message: `kein gelöschter Draft mit id '${id}'`,
        });
        return;
      }
      const draft = await deps.store.load(email, id);
      res.json({ draft });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(409).json({
          code: err.code,
          message: err.message,
          quota: err.snapshot,
        });
        return;
      }
      sendError(res, err, 'builder.restore_failed');
    }
  });

  // ── Preview-runtime routes (B.3) ────────────────────────────────────────
  if (deps.preview) {
    registerBuilderPreviewRoutes(router, deps.preview);
  }

  // ── Builder-chat routes (B.4-3) ────────────────────────────────────────
  if (deps.chat) {
    registerBuilderChatRoutes(router, deps.chat);
  }

  // ── Builder inline-edit routes (B.4-4) ─────────────────────────────────
  if (deps.editing) {
    registerBuilderEditRoutes(router, deps.editing);
  }

  // ── Builder SSE event stream (B.5-4) ──────────────────────────────────
  if (deps.events) {
    registerBuilderEventsRoutes(router, deps.events);
  }

  // ── Builder install-commit (B.6-1) ─────────────────────────────────────
  if (deps.install) {
    registerBuilderInstallRoutes(router, deps.install);
  }

  return router;
}

// ── helpers ────────────────────────────────────────────────────────────────

function requireEmail(req: Request): string {
  const email = req.session?.email;
  if (!email) {
    const err = new Error('no session email on request');
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
  return email;
}

function requireId(req: Request): string {
  const raw = req.params['id'];
  if (typeof raw !== 'string' || raw.length === 0) {
    const err = new Error('missing id');
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  return raw;
}

function parseScope(value: unknown): DraftListOptions['scope'] {
  if (value === 'all' || value === 'deleted' || value === 'active') return value;
  return 'active';
}

function parseStatus(value: unknown): DraftStatus | undefined {
  if (value === 'draft' || value === 'installed' || value === 'archived') {
    return value;
  }
  return undefined;
}

function isValidModel(value: unknown): value is BuilderModelId {
  return (
    typeof value === 'string' && BuilderModelRegistry.has(value)
  );
}

// ── Types-endpoint helper (B.6-11) ────────────────────────────────────────
// Resolves the lib bundle for a Monaco editor — boilerplate `types.ts`
// plus the `@omadia/plugin-api` `.d.ts` exports. Memoized per
// template so we don't re-read disk on every keystroke.

interface DraftLib {
  path: string;
  content: string;
}

const draftLibsCache = new Map<string, DraftLib[]>();

async function loadDraftLibs(templateId: string): Promise<DraftLib[]> {
  const cached = draftLibsCache.get(templateId);
  if (cached) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const boilerplateRoot = ASSETS.boilerplate.root;
  const pluginApiDist = path.resolve(
    here,
    '../../packages/plugin-api/dist',
  );

  const libs: DraftLib[] = [];

  // 1) Boilerplate's own types.ts — the PluginContext shape that the slot
  //    files (toolkit.ts / client.ts / plugin.ts) import via `./types.js`.
  try {
    const typesPath = path.join(boilerplateRoot, templateId, 'types.ts');
    const content = await fs.readFile(typesPath, 'utf-8');
    libs.push({
      path: `file:///boilerplate/${templateId}/types.ts`,
      content,
    });
  } catch {
    // No types.ts in this template — pure-llm has it, integration has it,
    // but a future template might not. Non-fatal.
  }

  // 2) plugin-api `.d.ts` exports — gives the operator autocomplete on
  //    things like Toolkit, ToolDescriptor, ConversationEntry, etc. when
  //    they import from '@omadia/plugin-api'.
  try {
    const entries = await fs.readdir(pluginApiDist, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
      const full = path.join(pluginApiDist, entry.name);
      const content = await fs.readFile(full, 'utf-8');
      libs.push({
        path: `file:///node_modules/@omadia/plugin-api/${entry.name}`,
        content,
      });
    }
  } catch {
    // plugin-api dist not built — ship without those autocompletions
    // rather than 500-ing the endpoint.
  }

  draftLibsCache.set(templateId, libs);
  return libs;
}

function sendError(res: Response, err: unknown, fallbackCode: string): void {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status: number }).status) || 500
      : 500;
  const message = err instanceof Error ? err.message : String(err);
  res.status(status).json({
    code: status === 401 ? 'auth.missing' : fallbackCode,
    message,
  });
}
