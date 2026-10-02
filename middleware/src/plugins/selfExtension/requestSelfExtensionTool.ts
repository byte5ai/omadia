/**
 * Plugin self-extension — the agent-in-loop auto-author tool (Theme A).
 *
 * A kernel native tool the agent MAY call when a tool result carried a
 * `[tool-limit:…]` note and it cannot finish the task because of that limit.
 * The agent supplies the plugin whose tool is limited + the extension template
 * to instantiate; the tool submits a proposal to the {@link OperatorGate} as
 * `pending` — NEVER auto-approved. The escalation guard still auto-denies any
 * privilege widening, and a human operator must approve before it takes effect.
 *
 * v1 covers the TEMPLATE path (standalone plugins exposing a `selfExtend`
 * contract — the Dynamics use case). Builder-spec plugins are extended through
 * the operator UI, which is owner-scoped (an agent turn has no operator email).
 *
 * Registered as a kernel tool via `nativeToolRegistry.register(...)` so it is
 * offered in every agent's tool list; dispatch is the registry's generic path.
 */

import type { NativeToolSpec } from '@omadia/plugin-api';

import type { PluginCatalog } from '../manifestLoader.js';
import type { NotificationRouter } from '../../platform/notificationRouter.js';
import type { OperatorGate } from './operatorGate.js';
import type { SelfExtendRegistry } from './selfExtendRegistry.js';
import { parseTemplateProposal, type TemplateProposal } from './extensionProposal.js';

export const REQUEST_SELF_EXTENSION_TOOL = 'request_self_extension';

export interface RequestSelfExtensionToolDeps {
  gate: OperatorGate;
  pluginCatalog: PluginCatalog;
  selfExtendRegistry: SelfExtendRegistry;
  notificationRouter?: NotificationRouter;
  /** Cap on concurrently-pending proposals per plugin (spam guard). Default 5. */
  maxPendingPerPlugin?: number;
  log?: (msg: string) => void;
}

export interface KernelToolRegistration {
  name: string;
  spec: NativeToolSpec;
  promptDoc: string;
  handler: (input: unknown) => Promise<string>;
}

const PROMPT_DOC =
  `${REQUEST_SELF_EXTENSION_TOOL}: when a tool result contains a "[tool-limit:…]" ` +
  `note and you cannot complete the task because of that structural limit, you MAY ` +
  `propose an operator-approved self-extension that lifts it. Supply targetPluginId ` +
  `(the plugin whose tool is limited), a one-line rationale, the templateId to ` +
  `instantiate (see the plugin's offered templates), and its params. The proposal ` +
  `is submitted for OPERATOR APPROVAL — it does NOT take effect immediately, and it ` +
  `is auto-denied if it would exceed the plugin's existing permissions. Do not call ` +
  `it speculatively; only when a concrete limit blocks the user's request.`;

interface ToolInput {
  targetPluginId?: unknown;
  rationale?: unknown;
  templateId?: unknown;
  params?: unknown;
}

export function createRequestSelfExtensionTool(
  deps: RequestSelfExtensionToolDeps,
): KernelToolRegistration {
  const maxPending = deps.maxPendingPerPlugin ?? 5;
  const log = deps.log ?? (() => {});

  const handler = async (raw: unknown): Promise<string> => {
    const input = (raw ?? {}) as ToolInput;
    const targetPluginId = typeof input.targetPluginId === 'string' ? input.targetPluginId : '';
    const rationale = typeof input.rationale === 'string' ? input.rationale : '';
    const templateId = typeof input.templateId === 'string' ? input.templateId : '';
    if (!targetPluginId || !rationale || !templateId) {
      return 'request_self_extension needs targetPluginId, rationale and templateId.';
    }

    const plugin = deps.pluginCatalog.get(targetPluginId)?.plugin;
    if (!plugin) {
      return `No installed plugin '${targetPluginId}'.`;
    }
    if (!deps.selfExtendRegistry.has(targetPluginId)) {
      return `Plugin '${targetPluginId}' does not support self-extension (it exposes no templates). It must be extended by an operator instead.`;
    }

    // Dedupe + rate-limit against open proposals.
    const pending = deps.gate.list({ pluginId: targetPluginId, status: 'pending' });
    const dup = pending.find(
      (r) => r.kind === 'template' && (r.proposal as TemplateProposal).templateId === templateId,
    );
    if (dup) {
      return `A self-extension for template '${templateId}' on '${targetPluginId}' is already pending operator review (${dup.id}).`;
    }
    if (pending.length >= maxPending) {
      return `Too many pending self-extension proposals for '${targetPluginId}' (${pending.length}); wait for operator review.`;
    }

    let proposal: TemplateProposal;
    try {
      proposal = parseTemplateProposal({
        pluginId: targetPluginId,
        rationale,
        templateId,
        params: (input.params ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      return `Invalid self-extension request: ${err instanceof Error ? err.message : String(err)}`;
    }

    const template = deps.selfExtendRegistry.getTemplate(targetPluginId, templateId);
    const record = deps.gate.submit({
      kind: 'template',
      pluginId: targetPluginId,
      plugin,
      template,
      proposal,
      submittedBy: 'agent:auto-author',
    });

    if (record.status === 'pending') {
      if (deps.notificationRouter) {
        try {
          await deps.notificationRouter.dispatch(targetPluginId, {
            title: 'Self-extension proposal pending',
            body: `An agent proposed extending ${targetPluginId} via template "${templateId}": ${rationale}`,
            deepLink: `/store/${encodeURIComponent(targetPluginId)}`,
          });
        } catch (err) {
          log(`[request_self_extension] notify failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return `Submitted self-extension proposal ${record.id} for '${targetPluginId}' (template '${templateId}'). It is PENDING operator approval and will not take effect until an operator approves it. Continue with what you can do now and tell the user the capability was requested.`;
    }

    const why =
      record.evaluation.escalations.length > 0
        ? record.evaluation.escalations.map((e) => `${e.dimension}:${e.item}`).join(', ')
        : (record.denialReason ?? 'invalid');
    return `Self-extension was auto-denied (${why}). The requested capability would exceed the plugin's existing permissions, so it cannot be granted automatically; the user should raise it with an operator.`;
  };

  const spec: NativeToolSpec = {
    name: REQUEST_SELF_EXTENSION_TOOL,
    description:
      'Propose an operator-approved self-extension for a plugin whose tool hit a structural limit (a "[tool-limit:…]" note). Submits for operator approval; never takes effect on its own.',
    input_schema: {
      type: 'object',
      properties: {
        targetPluginId: { type: 'string', description: 'Plugin whose tool is limited.' },
        rationale: { type: 'string', description: 'One line: which limit, why the extension is needed.' },
        templateId: { type: 'string', description: 'Extension template offered by the plugin.' },
        params: { type: 'object', description: 'Params for the template.' },
      },
      required: ['targetPluginId', 'rationale', 'templateId'],
    },
  };

  return { name: REQUEST_SELF_EXTENSION_TOOL, spec, promptDoc: PROMPT_DOC, handler };
}
