import type { Router, Request, Response } from 'express';
import { z } from 'zod';

import { parseAgentSpec } from '../plugins/builder/agentSpec.js';
import { JsonPatchSchema } from '../plugins/builder/specPatcher.js';
import type { DraftStore } from '../plugins/builder/draftStore.js';
import type { BuildPipeline } from '../plugins/builder/buildPipeline.js';
import type { PackageUploadService } from '../plugins/packageUploadService.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type {
  OperatorGate,
  SelfExtendRegistry,
  ExtensionStore,
} from '../plugins/selfExtension/index.js';
import {
  NarrowingWidensError,
  IllegalProposalTransitionError,
  ProposalNotFoundError,
  parseExtensionProposal,
  parseTemplateProposal,
  materializeApprovedProposal,
  type ProposalRecord,
  type ExtensionProposal,
  type TemplateProposal,
} from '../plugins/selfExtension/index.js';

/**
 * Plugin self-extension HTTP surface — the operator-facing API for the
 * non-escalating self-extension lifecycle (design doc:
 * docs/harness-platform/DESIGN-plugin-self-extension.md).
 *
 *   POST /self-extension/:agentId/propose            submit a proposal
 *   GET  /self-extension/proposals                   list (filter agentId/status)
 *   GET  /self-extension/proposals/:proposalId       fetch one
 *   POST /self-extension/proposals/:proposalId/approve   approve (optional narrowing)
 *   POST /self-extension/proposals/:proposalId/deny      deny with reason
 *   POST /self-extension/proposals/:proposalId/install   materialise + reactivate
 *
 * The proposal is evaluated against the plugin's CURRENT spec (resolved via
 * `DraftStore.findByPublishedAgentId` — the source draft the operator built).
 * The escalation guard auto-denies any privilege widening on submit, so a
 * `denied` verdict comes back 200 with `decision` + `escalations` for the UI to
 * render; only pre-processing failures (auth, missing id, no source spec, bad
 * body) are 4xx.
 *
 * Mounted under `/api/v1/builder` (shares the install dependency surface).
 * Behind `requireAuth`; every operation is owner-scoped via `req.session.email`.
 */

export interface SelfExtensionRouteDeps {
  /** Process-singleton gate holding the in-memory proposal store. */
  gate: OperatorGate;
  draftStore: DraftStore;
  buildPipeline: BuildPipeline;
  packageUploadService: PackageUploadService;
  /** Theme B (standalone plugins): template registry + manifest catalog +
   *  approved-extension store + reactivation. When absent, template proposals
   *  are rejected and only the Builder-spec path is available. */
  pluginCatalog?: PluginCatalog;
  selfExtendRegistry?: SelfExtendRegistry;
  extensionStore?: ExtensionStore;
  reactivate?: (pluginId: string) => Promise<void>;
  log?: (line: string) => void;
}

const ApproveBodySchema = z
  .object({ narrowingPatches: z.array(JsonPatchSchema).optional() })
  .strict();

const DenyBodySchema = z.object({ reason: z.string().min(1) }).strict();

export function registerSelfExtensionRoutes(
  router: Router,
  deps: SelfExtensionRouteDeps,
): void {
  router.post('/self-extension/:agentId/propose', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const agentId = readParam(req, 'agentId');
    if (!agentId) return sendJson(res, 400, { code: 'self_ext.invalid_agent_id', message: 'missing :agentId' });

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Template proposal (standalone-plugin path): body carries a `templateId`.
    if (typeof body['templateId'] === 'string') {
      if (!deps.pluginCatalog || !deps.selfExtendRegistry) {
        return sendJson(res, 501, {
          code: 'self_ext.templates_unavailable',
          message: 'template self-extension is not wired on this server',
        });
      }
      let proposal;
      try {
        proposal = parseTemplateProposal({ ...body, pluginId: agentId });
      } catch (err) {
        return sendJson(res, 400, {
          code: 'self_ext.invalid_proposal',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      const plugin = deps.pluginCatalog.get(agentId)?.plugin;
      if (!plugin) {
        return sendJson(res, 404, {
          code: 'self_ext.plugin_not_found',
          message: `plugin '${agentId}' is not installed`,
        });
      }
      const template = deps.selfExtendRegistry.getTemplate(agentId, proposal.templateId);
      const record = deps.gate.submit({
        kind: 'template',
        pluginId: agentId,
        plugin,
        template,
        proposal,
        submittedBy: email,
      });
      return sendJson(res, 200, { ok: true, proposal: serializeRecord(record) });
    }

    // Spec proposal (Builder-plugin path): patches against the source draft.
    let proposal;
    try {
      proposal = parseExtensionProposal({ ...body, pluginId: agentId });
    } catch (err) {
      return sendJson(res, 400, {
        code: 'self_ext.invalid_proposal',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const draft = await deps.draftStore.findByPublishedAgentId(email, agentId);
    if (!draft) {
      return sendJson(res, 404, {
        code: 'self_ext.source_not_found',
        message: `no source draft for installed plugin '${agentId}' owned by this operator (a standalone plugin must propose via a template)`,
      });
    }
    let currentSpec;
    try {
      currentSpec = parseAgentSpec(draft.spec);
    } catch (err) {
      return sendJson(res, 422, {
        code: 'self_ext.spec_invalid',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const record = deps.gate.submit({ pluginId: agentId, currentSpec, proposal, submittedBy: email });
    return sendJson(res, 200, { ok: true, proposal: serializeRecord(record) });
  });

  router.get('/self-extension/:agentId/templates', (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const agentId = readParam(req, 'agentId');
    if (!agentId) return sendJson(res, 400, { code: 'self_ext.invalid_agent_id', message: 'missing :agentId' });
    const templates = deps.selfExtendRegistry?.templates(agentId) ?? [];
    return sendJson(res, 200, {
      ok: true,
      templates: templates.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        paramsSchema: t.paramsSchema,
      })),
    });
  });

  router.get('/self-extension/proposals', (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const agentId = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : undefined;
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const records = deps.gate.list({
      ...(agentId ? { pluginId: agentId } : {}),
      ...(status ? { status: status as ProposalRecord['status'] } : {}),
    });
    return sendJson(res, 200, { ok: true, proposals: records.map(serializeRecord) });
  });

  router.get('/self-extension/proposals/:proposalId', (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const id = readParam(req, 'proposalId');
    if (!id) return sendJson(res, 400, { code: 'self_ext.invalid_id', message: 'missing :proposalId' });
    const record = deps.gate.get(id);
    if (!record) return sendJson(res, 404, { code: 'self_ext.not_found', message: `proposal '${id}' not found` });
    return sendJson(res, 200, { ok: true, proposal: serializeRecord(record) });
  });

  router.post('/self-extension/proposals/:proposalId/approve', (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const id = readParam(req, 'proposalId');
    if (!id) return sendJson(res, 400, { code: 'self_ext.invalid_id', message: 'missing :proposalId' });

    const parsed = ApproveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendJson(res, 400, { code: 'self_ext.invalid_body', message: parsed.error.message });
    }
    try {
      const record = deps.gate.approve({
        id,
        decidedBy: email,
        ...(parsed.data.narrowingPatches ? { narrowingPatches: parsed.data.narrowingPatches } : {}),
      });
      return sendJson(res, 200, { ok: true, proposal: serializeRecord(record) });
    } catch (err) {
      return mapDecisionError(res, err);
    }
  });

  router.post('/self-extension/proposals/:proposalId/deny', (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const id = readParam(req, 'proposalId');
    if (!id) return sendJson(res, 400, { code: 'self_ext.invalid_id', message: 'missing :proposalId' });
    const parsed = DenyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendJson(res, 400, { code: 'self_ext.invalid_body', message: parsed.error.message });
    }
    try {
      const record = deps.gate.deny(id, email, parsed.data.reason);
      return sendJson(res, 200, { ok: true, proposal: serializeRecord(record) });
    } catch (err) {
      return mapDecisionError(res, err);
    }
  });

  router.post('/self-extension/proposals/:proposalId/install', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    const id = readParam(req, 'proposalId');
    if (!id) return sendJson(res, 400, { code: 'self_ext.invalid_id', message: 'missing :proposalId' });

    const result = await materializeApprovedProposal(
      { proposalId: id, userEmail: email },
      {
        gate: deps.gate,
        draftStore: deps.draftStore,
        buildPipeline: deps.buildPipeline,
        packageUploadService: deps.packageUploadService,
        ...(deps.extensionStore ? { extensionStore: deps.extensionStore } : {}),
        ...(deps.reactivate ? { reactivate: deps.reactivate } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      },
    );
    if (result.ok) {
      const proposal = serializeRecord(deps.gate.get(id) as ProposalRecord);
      return sendJson(
        res,
        200,
        result.kind === 'spec'
          ? {
              ok: true,
              publishedAgentId: result.install.publishedAgentId,
              version: result.install.version,
              proposal,
            }
          : { ok: true, pluginId: result.pluginId, templateId: result.templateId, proposal },
      );
    }
    const status = result.stage === 'precondition' ? 409 : 422;
    return sendJson(res, status, {
      ok: false,
      stage: result.stage,
      message: result.message,
      ...(result.install ? { reason: result.install.reason, code: result.install.code } : {}),
    });
  });
}

// ---------------------------------------------------------------------------

/** Operator-facing view of a proposal record. Deliberately omits the full
 *  specs (large) — exposes the verdict, escalations, and a tool-count delta. */
function serializeRecord(record: ProposalRecord): Record<string, unknown> {
  const ev = record.evaluation;
  const kindFields =
    record.kind === 'template'
      ? { kind: 'template', templateId: (record.proposal as TemplateProposal).templateId }
      : { kind: 'spec', patchCount: (record.proposal as ExtensionProposal).patches.length };
  return {
    id: record.id,
    pluginId: record.pluginId,
    ...kindFields,
    status: record.status,
    decision: ev.decision,
    rationale: record.proposal.rationale,
    escalations: ev.escalations,
    ...(ev.invalidReason ? { invalidReason: ev.invalidReason } : {}),
    submittedBy: record.submittedBy,
    createdAt: record.createdAt,
    ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.denialReason ? { denialReason: record.denialReason } : {}),
    ...(record.narrowingPatches ? { narrowed: true } : {}),
    ...(record.installFailureReason ? { installFailureReason: record.installFailureReason } : {}),
    ...(record.approvedSpec ? { approvedToolCount: record.approvedSpec.tools.length } : {}),
  };
}

function mapDecisionError(res: Response, err: unknown): Response {
  if (err instanceof ProposalNotFoundError) {
    return sendJson(res, 404, { code: 'self_ext.not_found', message: err.message });
  }
  if (err instanceof NarrowingWidensError) {
    return sendJson(res, 409, {
      code: 'self_ext.narrowing_widens',
      message: err.message,
      widenings: err.widenings,
    });
  }
  if (err instanceof IllegalProposalTransitionError) {
    return sendJson(res, 409, { code: 'self_ext.illegal_transition', message: err.message });
  }
  // spec-validation failure inside applySpecPatches (narrowing) etc.
  return sendJson(res, 422, {
    code: 'self_ext.unprocessable',
    message: err instanceof Error ? err.message : String(err),
  });
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readParam(req: Request, name: string): string | null {
  const raw = req.params[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(res: Response, status: number, body: Record<string, unknown>): Response {
  return res.status(status).json(body);
}
