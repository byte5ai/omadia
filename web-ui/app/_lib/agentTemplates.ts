import { callJson } from './agents';
import type { AgentIdentityInput } from './agentIdentity';

/**
 * Spec 2042 §5.10 — agent templates: presets of identity, personality and
 * suggested capabilities that installed plugins ship and the operator turns
 * into agents in the Agent Builder. Read from the admin template API
 * (`middleware/src/routes/agentTemplates.ts`); the template itself creates
 * and grants nothing.
 */

/** One suggested capability, resolved against this instance. */
export interface SuggestedCapabilityDto {
  plugin_id: string;
  installed: boolean;
  /** Delivers capabilities, i.e. can be granted to an agent at all. */
  grantable: boolean;
}

export interface AgentTemplateSummaryDto {
  plugin_id: string;
  plugin_name: string;
  plugin_version: string;
  template_id: string;
  archetype: string;
  /** The archetype's plugin is installed; without it no agent can be made. */
  archetype_available: boolean;
  name: string;
  short_description: string | null;
  language: string | null;
  suggested_capabilities: SuggestedCapabilityDto[];
}

/** One template as the bodies of the create and identity routes. */
export interface AgentTemplatePrefillDto {
  template: AgentTemplateSummaryDto;
  agent: { name: string; description?: string; archetype: string };
  identity: Pick<
    AgentIdentityInput,
    | 'display_name'
    | 'short_description'
    | 'long_description'
    | 'instructions'
    | 'verbosity'
    | 'persona'
    | 'quality'
  > & { language: string | null };
}

/** A capability the operator may choose to grant: installed and grantable. */
export function isOfferedCapability(c: SuggestedCapabilityDto): boolean {
  return c.installed && c.grantable;
}

export async function listAgentTemplates(): Promise<AgentTemplateSummaryDto[]> {
  const res = await callJson<{ templates: AgentTemplateSummaryDto[] }>('/v1/admin/agent-templates');
  return res.templates;
}

export async function getAgentTemplatePrefill(
  pluginId: string,
  templateId: string,
): Promise<AgentTemplatePrefillDto> {
  const q = new URLSearchParams({ plugin: pluginId, template: templateId });
  return callJson<AgentTemplatePrefillDto>(`/v1/admin/agent-templates/prefill?${q.toString()}`);
}

// ── export (#2049) ───────────────────────────────────────────────────────

/** One `agent_templates:` entry, as `GET /operator/agents/:slug/template` emits it. */
export interface AgentTemplateEntryDto {
  id: string;
  archetype?: string;
  name: string;
  short_description?: string;
  long_description?: string;
  instructions?: string;
  language?: string;
  verbosity?: string;
  persona?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  capabilities?: string[];
}

export async function getAgentTemplateExport(slug: string): Promise<AgentTemplateEntryDto> {
  const res = await callJson<{ agent_templates: AgentTemplateEntryDto[] }>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/template`,
  );
  const [entry] = res.agent_templates;
  if (!entry) throw new Error(`the export of agent '${slug}' holds no template`);
  return entry;
}

/** Same-origin URL of the YAML download (browser only). */
export function agentTemplateDownloadUrl(slug: string): string {
  return `/bot-api/v1/operator/agents/${encodeURIComponent(slug)}/template?format=yaml`;
}
