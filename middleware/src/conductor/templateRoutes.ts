// Workflow-template routes (issues #429, #478), registered by createConductorRouter
// BEFORE its '/:slug' catch-all. Split out of routes.ts purely for file size — the
// deps object, mount point and route order are unchanged.
//
// Read paths (list/get/versions/resolve/instantiate) are viewer-scoped through the
// composite catalog's visibility rule: bundled/plugin templates and 'shared'/'pending'
// user templates are visible to every operator (every operator is a potential
// reviewer on the single-tier operator API), 'private' ones only to their author.
// Write paths (POST/PUT/DELETE) are author-only on user-source templates.

import type { Request, Response, Router } from 'express';

import {
  applyTemplateSlots,
  checkTemplateManifest,
  missingSlotMappings,
  resolveLocalizedText,
  templateManifestVersion,
  validate,
} from '@omadia/conductor-core';
import type { JsonObject, TemplateManifest, TemplateSlotMapping, WorkflowGraph } from '@omadia/conductor-core';

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
}
