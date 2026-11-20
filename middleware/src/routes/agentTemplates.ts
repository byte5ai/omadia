import { Router, type Request, type Response } from 'express';

import {
  CAPABILITY_PLUGIN_KINDS,
  effectiveKind,
  type Plugin,
  type PluginAgentTemplate,
} from '../api/admin-v1.js';

/**
 * Spec 2042 §5.10 — the agent templates of the installed plugins, for the
 * Agent Builder:
 *
 *   GET /api/v1/admin/agent-templates
 *       every template of every installed plugin, as a summary
 *   GET /api/v1/admin/agent-templates/prefill?plugin=<id>&template=<id>
 *       one template as the bodies of `POST /api/v1/operator/agents` and
 *       `PUT /api/v1/operator/agents/:slug/identity`
 *
 * Read-only by design. A template is inactive metadata; the agent is
 * created by the Agent Builder (as a draft) and only the operator decides
 * what it is granted. Nothing here creates an agent or grants a capability.
 */

export interface AgentTemplatesDeps {
  /** The plugins of the catalog (installed and not). */
  readonly listPlugins: () => readonly Plugin[];
  /** Whether a plugin is installed on this instance. */
  readonly isInstalled: (pluginId: string) => boolean;
  /** Whether an archetype is registered (its plugin installed and loaded). */
  readonly isArchetypeRegistered: (archetypeId: string) => boolean;
}

/** One suggested capability, resolved against this instance. */
export interface SuggestedCapabilityDto {
  readonly plugin_id: string;
  readonly installed: boolean;
  /** Whether the plugin delivers capabilities, i.e. can be granted at all. */
  readonly grantable: boolean;
}

export function createAgentTemplatesRouter(deps: AgentTemplatesDeps): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const templates = installedTemplates(deps).map(({ plugin, template }) => summaryDto(deps, plugin, template));
    res.json({ templates });
  });

  router.get('/prefill', (req: Request, res: Response) => {
    const pluginId = queryString(req, 'plugin');
    const templateId = queryString(req, 'template');
    if (!pluginId || !templateId) {
      res.status(400).json({
        code: 'agent_template.ref_missing',
        message: 'query parameters `plugin` and `template` are required',
      });
      return;
    }
    const found = installedTemplates(deps).find(
      ({ plugin, template }) => plugin.id === pluginId && template.id === templateId,
    );
    if (!found) {
      res.status(404).json({
        code: 'agent_template.not_found',
        message: `no installed plugin '${pluginId}' with an agent template '${templateId}'`,
      });
      return;
    }
    res.json(prefillDto(deps, found.plugin, found.template));
  });

  return router;
}

interface TemplateOfPlugin {
  readonly plugin: Plugin;
  readonly template: PluginAgentTemplate;
}

function installedTemplates(deps: AgentTemplatesDeps): TemplateOfPlugin[] {
  return deps
    .listPlugins()
    .filter((plugin) => deps.isInstalled(plugin.id))
    .flatMap((plugin) => (plugin.agent_templates ?? []).map((template) => ({ plugin, template })));
}

function queryString(req: Request, key: string): string | undefined {
  const raw = req.query[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function summaryDto(
  deps: AgentTemplatesDeps,
  plugin: Plugin,
  template: PluginAgentTemplate,
): Record<string, unknown> {
  return {
    plugin_id: plugin.id,
    plugin_name: plugin.name,
    plugin_version: plugin.version,
    template_id: template.id,
    archetype: template.archetype,
    // A template for an archetype whose plugin is not installed cannot
    // become an agent here; the Builder shows it, but cannot create from it.
    archetype_available: deps.isArchetypeRegistered(template.archetype),
    name: template.name,
    short_description: template.short_description ?? null,
    language: template.language ?? null,
    suggested_capabilities: suggestedCapabilities(deps, template),
  };
}

/**
 * The template as the two bodies the Agent Builder sends. The `slug` and
 * the status (`draft`) are the Builder's; the field names and limits are
 * those of the create and identity routes, so the bodies pass unchanged.
 */
function prefillDto(
  deps: AgentTemplatesDeps,
  plugin: Plugin,
  template: PluginAgentTemplate,
): Record<string, unknown> {
  return {
    template: summaryDto(deps, plugin, template),
    agent: {
      name: template.name,
      ...(template.short_description !== undefined ? { description: template.short_description } : {}),
      archetype: template.archetype,
    },
    identity: {
      display_name: template.name,
      short_description: template.short_description ?? null,
      long_description: template.long_description ?? null,
      instructions: template.instructions ?? null,
      language: template.language ?? null,
      persona: template.persona ?? null,
      quality: template.quality ?? null,
    },
  };
}

function suggestedCapabilities(
  deps: AgentTemplatesDeps,
  template: PluginAgentTemplate,
): SuggestedCapabilityDto[] {
  const byId = new Map(deps.listPlugins().map((p) => [p.id, p]));
  return template.capabilities.map((id) => {
    const plugin = byId.get(id);
    return {
      plugin_id: id,
      installed: deps.isInstalled(id),
      grantable: plugin !== undefined && CAPABILITY_PLUGIN_KINDS.has(effectiveKind(plugin.kind)),
    };
  });
}
