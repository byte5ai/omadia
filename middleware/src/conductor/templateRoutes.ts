// Workflow-template routes (issues #429, #478), registered by createConductorRouter
// BEFORE its '/:slug' catch-all. Split out of routes.ts purely for file size — the
// deps object, mount point and route order are unchanged.
//
// Read paths (list/get/versions/resolve/instantiate) are viewer-scoped through the
// composite catalog's visibility rule: bundled/plugin templates and 'shared'/'pending'
// user templates are visible to every operator (every operator is a potential
// reviewer on the single-tier operator API), 'private' ones only to their author.
// Write paths (POST/PUT/DELETE) are author-only on user-source templates.

import type { Request, RequestHandler, Response, Router } from 'express';

import {
  applyTemplateSlots,
  checkTemplateManifest,
  inferTemplateManifest,
  missingSlotMappings,
  resolveLocalizedText,
  templateManifestVersion,
  validate,
} from '@omadia/conductor-core';
import type { JsonObject, LocalizedText, TemplateManifest, TemplateSlotMapping, WorkflowGraph } from '@omadia/conductor-core';

import { WorkflowSlugExistsError } from './workflowStore.js';
import { TemplateIdExistsError, TemplateInvalidError } from './templateStore.js';
import type { TemplateSummary } from './templateCatalog.js';
import type { ConductorRouterDeps } from './routes.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObject(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}

function paramStr(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

/** Body-supplied manifest metadata: a non-empty plain string or an { en, ... }
 *  locale record passes through; anything else falls back to the caller's
 *  default. Shape validation stays checkTemplateManifest's job at publish. */
function asLocalizedText(v: unknown): LocalizedText | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v;
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as LocalizedText;
  return undefined;
}

export function registerTemplateRoutes(router: Router, deps: ConductorRouterDeps): void {
  // Viewer identity for the template surface — same source as the awaits responder.
  const viewerOf = (req: Request): string => req.session?.sub ?? 'operator';

  // Resolves a template + version for read paths (resolve/instantiate). The
  // VISIBILITY rule lives in the catalog's viewer-scoped get; an explicit
  // `version` (default: latest) is served from the version store for user
  // templates. Writes the error response and returns null on any failure.
  async function templateManifestFor(id: string, body: JsonObject, res: Response, viewer: string): Promise<TemplateManifest | null> {
    const summary = await deps.templateCatalog?.get(id, viewer);
    if (!summary) {
      res.status(404).json({ code: 'conductor.template_not_found', message: `unknown template '${id}'` });
      return null;
    }
    if (body.version === undefined) return summary;
    const requested = body.version;
    if (!Number.isInteger(requested) || (requested as number) < 1) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'version must be an integer >= 1' });
      return null;
    }
    if (requested === summary.version) return summary;
    const manifest = summary.source === 'user' ? await deps.templateStore?.getVersion(id, requested as number) : undefined;
    if (!manifest) {
      res.status(404).json({ code: 'conductor.template_not_found', message: `template '${id}' has no version ${String(requested)}` });
      return null;
    }
    return manifest;
  }

  // Shared resolution path of resolve/instantiate (#429): manifest lookup → mapping
  // completeness gate → slot substitution → validation with LIVE KnownRefs. Deliberately
  // stricter than 'POST /' (structural only): a template instance must be runnable against
  // this install's agents/actions/roles/events, not merely well-formed. Writes the error
  // response and returns null on any failure.
  async function resolveTemplateGraph(id: string, body: JsonObject, res: Response, viewer: string): Promise<{ manifest: TemplateManifest; graph: WorkflowGraph } | null> {
    const manifest = await templateManifestFor(id, body, res, viewer);
    if (!manifest) return null;
    // Fail-clear before anything else: name every declared-but-unmapped slot
    // (v2: may include kind:'text' entries — additive over the v1 envelope).
    const mapping = asObject(body.mapping) as TemplateSlotMapping;
    const missing = missingSlotMappings(manifest, mapping);
    if (missing.length > 0) {
      res.status(400).json({ code: 'conductor.template_slot_mapping_incomplete', missing });
      return null;
    }
    const graph = applyTemplateSlots(manifest, mapping);
    const knownRefs = deps.templateKnownRefs ? await deps.templateKnownRefs() : undefined;
    const result = validate(graph, knownRefs);
    if (!result.ok) {
      res.status(400).json({ code: 'conductor.invalid_graph', errors: result.errors });
      return null;
    }
    return { manifest, graph };
  }

  // Resolves :id to a USER template the viewer may WRITE (author-only). Visibility
  // first (invisible = 404, exactly like the read paths), then source/ownership
  // (403). Writes the error response and returns null on any failure.
  async function writableUserTemplate(id: string, res: Response, viewer: string): Promise<TemplateSummary | null> {
    const summary = await deps.templateCatalog?.get(id, viewer);
    if (!summary) {
      res.status(404).json({ code: 'conductor.template_not_found', message: `unknown template '${id}'` });
      return null;
    }
    if (summary.source !== 'user') {
      res.status(403).json({ code: 'conductor.template_forbidden', message: `template '${id}' is a read-only ${summary.source} template` });
      return null;
    }
    if (summary.createdBy !== viewer) {
      res.status(403).json({ code: 'conductor.template_forbidden', message: `template '${id}' belongs to another author` });
      return null;
    }
    return summary;
  }

  // Workflow-template catalog (#429, viewer-scoped since #478) — full manifests incl.
  // graph + slot declarations plus ADDITIVE metadata (source/status/version/counts;
  // the v1 fields are untouched, #330 keeps working).
  router.get('/templates', async (req: Request, res: Response): Promise<void> => {
    try {
      res.json({ templates: (await deps.templateCatalog?.list(viewerOf(req))) ?? [] });
    } catch (err) {
      res.status(500).json({ code: 'conductor.templates_failed', message: errMsg(err) });
    }
  });

  // Single template, same visibility rule as the list (no 404-vs-list divergence).
  router.get('/templates/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = paramStr(req.params.id);
      const template = await deps.templateCatalog?.get(id, viewerOf(req));
      if (!template) {
        res.status(404).json({ code: 'conductor.template_not_found', message: `unknown template '${id}'` });
        return;
      }
      res.json({ template });
    } catch (err) {
      res.status(500).json({ code: 'conductor.template_get_failed', message: errMsg(err) });
    }
  });

  // Create a user template (status 'private', owned by the viewer) — #478.
  router.post('/templates', async (req: Request, res: Response): Promise<void> => {
    if (!deps.templateStore || !deps.templateCatalog) {
      res.status(503).json({ code: 'conductor.templates_unavailable', message: 'template store is not wired' });
      return;
    }
    const manifest = asObject(asObject(req.body).manifest) as unknown as TemplateManifest;
    const check = checkTemplateManifest(manifest);
    if (!check.ok) {
      res.status(400).json({ code: 'conductor.template_invalid', errors: check.errors });
      return;
    }
    const viewer = viewerOf(req);
    try {
      // Ids of read-only sources are reserved; DB collisions (incl. other
      // authors' private templates) surface atomically from the INSERT.
      if (deps.templateCatalog.staticSource(manifest.id)) {
        res.status(409).json({ code: 'conductor.template_id_exists', message: `template id '${manifest.id}' is taken` });
        return;
      }
      await deps.templateStore.create(manifest, viewer);
      res.status(201).json({ template: await deps.templateCatalog.get(manifest.id, viewer) });
    } catch (err) {
      if (err instanceof TemplateIdExistsError) {
        res.status(409).json({ code: 'conductor.template_id_exists', message: err.message });
        return;
      }
      if (err instanceof TemplateInvalidError) {
        res.status(400).json({ code: 'conductor.template_invalid', errors: err.errors });
        return;
      }
      console.error('[conductor] template create failed:', err);
      res.status(500).json({ code: 'conductor.template_create_failed', message: errMsg(err) });
    }
  });

  // Publish the next manifest version onto an owned template (author-only) — #478.
  // Status is deliberately unchanged: the review gate governs SHARING, not each
  // version (publisher-maintenance path; an accepted, documented v1 tradeoff).
  router.put('/templates/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deps.templateStore || !deps.templateCatalog) {
      res.status(503).json({ code: 'conductor.templates_unavailable', message: 'template store is not wired' });
      return;
    }
    const id = paramStr(req.params.id);
    const viewer = viewerOf(req);
    const manifest = asObject(asObject(req.body).manifest) as unknown as TemplateManifest;
    try {
      if (!(await writableUserTemplate(id, res, viewer))) return;
      if (manifest.id !== id) {
        res.status(400).json({ code: 'conductor.invalid_input', message: `manifest.id must equal '${id}'` });
        return;
      }
      const check = checkTemplateManifest(manifest);
      if (!check.ok) {
        res.status(400).json({ code: 'conductor.template_invalid', errors: check.errors });
        return;
      }
      const record = await deps.templateStore.addVersion(id, manifest);
      if (!record) {
        res.status(404).json({ code: 'conductor.template_not_found', message: `unknown template '${id}'` });
        return;
      }
      res.json({ template: await deps.templateCatalog.get(id, viewer) });
    } catch (err) {
      if (err instanceof TemplateInvalidError) {
        res.status(400).json({ code: 'conductor.template_invalid', errors: err.errors });
        return;
      }
      console.error('[conductor] template update failed:', err);
      res.status(500).json({ code: 'conductor.template_update_failed', message: errMsg(err) });
    }
  });

  // Delete an owned user template (author-only; bundled/plugin are read-only) — #478.
  router.delete('/templates/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deps.templateStore) {
      res.status(503).json({ code: 'conductor.templates_unavailable', message: 'template store is not wired' });
      return;
    }
    try {
      const id = paramStr(req.params.id);
      if (!(await writableUserTemplate(id, res, viewerOf(req)))) return;
      await deps.templateStore.delete(id);
      res.status(204).end();
    } catch (err) {
      console.error('[conductor] template delete failed:', err);
      res.status(500).json({ code: 'conductor.template_delete_failed', message: errMsg(err) });
    }
  });

  // Version history (visibility-gated like every read) — #478.
  router.get('/templates/:id/versions', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = paramStr(req.params.id);
      const summary = await deps.templateCatalog?.get(id, viewerOf(req));
      if (!summary) {
        res.status(404).json({ code: 'conductor.template_not_found', message: `unknown template '${id}'` });
        return;
      }
      const versions =
        summary.source === 'user' && deps.templateStore
          ? await deps.templateStore.listVersions(id)
          : [{ version: summary.version }]; // bundled/plugin: a single, file-defined version
      res.json({ versions });
    } catch (err) {
      res.status(500).json({ code: 'conductor.template_versions_failed', message: errMsg(err) });
    }
  });

  // Review gate (#478): private → pending → shared, Make's team-template shape.
  // submit is author-only; approve/reject are open to ANY authenticated operator —
  // reachable because 'pending' is visible install-wide (the revised visibility
  // rule), with `reviewed_by` recorded for audit. Self-approval stays permitted
  // (single-operator installs must not deadlock); separation of duties is a
  // documented deferral.
  router.post('/templates/:id/submit', async (req: Request, res: Response): Promise<void> => {
    if (!deps.templateStore || !deps.templateCatalog) {
      res.status(503).json({ code: 'conductor.templates_unavailable', message: 'template store is not wired' });
      return;
    }
    const id = paramStr(req.params.id);
    const viewer = viewerOf(req);
    try {
      const summary = await writableUserTemplate(id, res, viewer);
      if (!summary) return;
      if (summary.status !== 'private') {
        res.status(409).json({
          code: 'conductor.template_status_conflict',
          message: `template '${id}' is '${summary.status ?? 'unknown'}' — only a private template can be submitted for review`,
        });
        return;
      }
      await deps.templateStore.setStatus(id, 'pending');
      res.json({ template: await deps.templateCatalog.get(id, viewer) });
    } catch (err) {
      console.error('[conductor] template submit failed:', err);
      res.status(500).json({ code: 'conductor.template_submit_failed', message: errMsg(err) });
    }
  });

  // approve → shared, reject → private. NB: a reject by a non-author flips the
  // template back to a status the reviewer cannot see — `template` is then null.
  const reviewRoute = (action: 'approve' | 'reject'): RequestHandler => async (req: Request, res: Response): Promise<void> => {
    if (!deps.templateStore || !deps.templateCatalog) {
      res.status(503).json({ code: 'conductor.templates_unavailable', message: 'template store is not wired' });
      return;
    }
    const id = paramStr(req.params.id);
    const viewer = viewerOf(req);
    try {
      // Viewer-scoped get, NOT the author-only writable check: any operator may
      // review, and 'pending' is visible to all of them (a non-author reviewer
      // must never 404 here).
      const summary = await deps.templateCatalog.get(id, viewer);
      if (!summary) {
        res.status(404).json({ code: 'conductor.template_not_found', message: `unknown template '${id}'` });
        return;
      }
      if (summary.source !== 'user') {
        res.status(403).json({ code: 'conductor.template_forbidden', message: `template '${id}' is a read-only ${summary.source} template` });
        return;
      }
      if (summary.status !== 'pending') {
        res.status(409).json({
          code: 'conductor.template_status_conflict',
          message: `template '${id}' is '${summary.status ?? 'unknown'}' — only a pending template can be ${action}d`,
        });
        return;
      }
      await deps.templateStore.setStatus(id, action === 'approve' ? 'shared' : 'private', viewer);
      res.json({ template: (await deps.templateCatalog.get(id, viewer)) ?? null });
    } catch (err) {
      console.error(`[conductor] template ${action} failed:`, err);
      res.status(500).json({ code: 'conductor.template_review_failed', message: errMsg(err) });
    }
  };
  router.post('/templates/:id/approve', reviewRoute('approve'));
  router.post('/templates/:id/reject', reviewRoute('reject'));

  // Ephemeral template instantiation (#429, the #330 seam and the UI's "open in designer"):
  // substitute + validate, return the ordinary graph, persist nothing. Optional body
  // `version` (default latest) serves an older manifest version (#478).
  router.post('/templates/:id/resolve', async (req: Request, res: Response): Promise<void> => {
    try {
      const resolved = await resolveTemplateGraph(paramStr(req.params.id), asObject(req.body), res, viewerOf(req));
      if (!resolved) return;
      res.json({ graph: resolved.graph });
    } catch (err) {
      console.error('[conductor] template resolve failed:', err);
      res.status(500).json({ code: 'conductor.template_resolve_failed', message: errMsg(err) });
    }
  });

  // Persistent template instantiation (#429): substitute + validate, then publish through
  // the ordinary createOrPublish path — the result is a normal versioned workflow with no
  // link back to the template (copy, not reference).
  router.post('/templates/:id/instantiate', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!slug) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'slug is required' });
      return;
    }
    try {
      const resolved = await resolveTemplateGraph(paramStr(req.params.id), body, res, viewerOf(req));
      if (!resolved) return;
      const manifestVersion = templateManifestVersion(resolved.manifest);
      // Slug collision → 409. Deliberate divergence from the 'POST /' upsert semantics:
      // instantiation means "create new"; silently publishing over an existing workflow
      // would be the Power Automate footgun. Enforced ATOMICALLY by expectNew (no racy
      // pre-check): of two racing instantiates exactly one INSERT wins, the loser 409s.
      const out = await deps.workflowStore.createOrPublish({
        slug,
        // Manifest fallbacks are localizable; the store persists plain strings → resolve to en.
        name: typeof body.name === 'string' && body.name.trim() ? body.name : resolveLocalizedText(resolved.manifest.name),
        description: typeof body.description === 'string' ? body.description : resolveLocalizedText(resolved.manifest.description),
        graph: resolved.graph,
        enable: body.enable === true,
        expectNew: true,
        // Atomic with the publish: reconcile cron schedules (same as 'POST /'; they only
        // fire while the workflow is enabled) and stamp {templateId, version} provenance
        // (#478 — copy-not-reference stands, the stamp only powers update hints).
        onPublished: async (client, workflowId) => {
          await deps.scheduleStore.reconcileOnClient(client, workflowId, resolved.graph);
          if (deps.templateStore) {
            await deps.templateStore.stampWorkflowProvenance(client, workflowId, resolved.manifest.id, manifestVersion);
          }
        },
      });
      // Anonymous usage telemetry (#478) — append-only, best-effort: a telemetry
      // failure must never fail an already-published workflow.
      if (deps.templateStore) {
        try {
          await deps.templateStore.recordInstantiation({
            templateId: resolved.manifest.id,
            templateName: resolveLocalizedText(resolved.manifest.name),
            version: manifestVersion,
            workflowSlug: slug,
          });
        } catch (err) {
          console.warn('[conductor] template instantiation telemetry failed:', errMsg(err));
        }
      }
      res.status(201).json({
        workflow: out.workflow,
        version: { id: out.version.id, version: out.version.version },
      });
    } catch (err) {
      if (err instanceof WorkflowSlugExistsError) {
        // Race loser of two concurrent creates of the same fresh slug (pre-check passed).
        res.status(409).json({ code: 'conductor.slug_exists', message: err.message });
        return;
      }
      console.error('[conductor] template instantiate failed:', err);
      res.status(500).json({ code: 'conductor.template_instantiate_failed', message: errMsg(err) });
    }
  });

  // Is `id` already claimed by ANY catalog entry? Read-only sources first, then
  // the store directly — other authors' PRIVATE templates also block the id
  // (the namespace is global), which the viewer-scoped catalog get would hide.
  async function templateIdTaken(id: string, viewer: string): Promise<boolean> {
    if (deps.templateCatalog?.staticSource(id)) return true;
    if (deps.templateStore) return (await deps.templateStore.get(id)) !== undefined;
    return (await deps.templateCatalog?.get(id, viewer)) !== undefined;
  }

  // Collision-free default id for a save-as-template draft: the slug itself,
  // then `-template`, then numeric suffixes.
  async function defaultTemplateId(slug: string, viewer: string): Promise<string> {
    const base = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
    if (!(await templateIdTaken(base, viewer))) return base;
    let candidate = `${base}-template`;
    for (let n = 2; await templateIdTaken(candidate, viewer); n += 1) candidate = `${base}-template-${String(n)}`;
    return candidate;
  }

  // "Save as template" (#478): reverse slot inference over the workflow's ACTIVE
  // published version. Returns a DRAFT manifest only — nothing is persisted; the
  // UI lets the author edit slots/metadata and then publishes via POST /templates
  // (fresh id) or PUT /templates/:id (new version of an owned id). Registered on
  // the template surface but path-scoped to the workflow: POST /:slug/save-as-template
  // (this router is mounted at /conductors, so there is no '/workflows' prefix).
  router.post('/:slug/save-as-template', async (req: Request, res: Response): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const body = asObject(req.body);
    const viewer = viewerOf(req);
    try {
      const wf = await deps.workflowStore.getBySlug(slug);
      const version = wf?.activeVersionId ? await deps.workflowStore.getVersion(wf.activeVersionId) : null;
      if (!wf || !version) {
        res.status(404).json({ code: 'conductor.workflow_not_found', message: `no published workflow '${slug}'` });
        return;
      }
      const requestedId = typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined;
      const draft = inferTemplateManifest(version.graph, {
        id: requestedId ?? (await defaultTemplateId(slug, viewer)),
        name: asLocalizedText(body.name) ?? wf.name,
        description: asLocalizedText(body.description) ?? wf.description ?? wf.name,
        // Free-string category; authors refine it in the dialog before publishing.
        useCase: asLocalizedText(body.useCase) ?? 'general',
        defaultSlug: slug,
      });
      res.json({ draft, sourceWorkflow: { slug, version: version.version } });
    } catch (err) {
      console.error('[conductor] save-as-template failed:', err);
      res.status(500).json({ code: 'conductor.save_as_template_failed', message: errMsg(err) });
    }
  });
}
