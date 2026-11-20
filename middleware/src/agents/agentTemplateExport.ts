import { stringify as stringifyYaml } from 'yaml';

import type { AgentIdentityRecord } from '../platform/agentIdentityStore.js';
import {
  readAgentTemplates,
  type AgentTemplateManifest,
} from '../plugins/agentTemplateManifest.js';

/**
 * #2049 — an agent as ONE entry of an `agent_templates:` block (spec 2042
 * §5.2: "exported agent templates keep the identity, skill and quality
 * parameters AGENT.md carries today"), in exactly the format
 * `plugins/agentTemplateManifest.ts` reads, so an export pastes into the
 * manifest of a capability plugin or an `agent-template` package.
 *
 * What goes in: the agent's archetype, its name, its authored identity
 * (descriptions, instructions, language, persona, quality) and the ids of
 * the capability plugins it is granted. What never goes in: the avatar,
 * plugin configuration (it may hold credentials), memory, channel bindings,
 * availability, model policy, or anything else about the running agent.
 * The template format has no field for verbosity or accent colour; those
 * stay with the agent.
 */

export interface AgentTemplateExportInput {
  readonly slug: string;
  /** The agent's own name (`agents.name`); the authored display name wins. */
  readonly name: string;
  readonly archetype: string;
  readonly identity: AgentIdentityRecord | undefined;
  /** Ids of the capability plugins the agent is granted (enabled rows). */
  readonly capabilities: readonly string[];
}

/** A template id derived from an agent slug: a lowercase letter first,
 *  then lowercase letters, digits and hyphens, at most 63 characters. */
export function templateIdFromSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const lettered = /^[a-z]/.test(cleaned) ? cleaned : `agent-${cleaned}`;
  return lettered.slice(0, 63).replace(/-+$/g, '');
}

/** The export would not read back; `reason` says why (fail loud). */
export class AgentTemplateExportError extends Error {
  constructor(
    readonly slug: string,
    readonly reason: string,
  ) {
    super(`agent '${slug}' does not export as a valid agent template: ${reason}`);
    this.name = 'AgentTemplateExportError';
  }
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The entry. Checked with the manifest reader itself before it leaves: an
 * export that the catalog would reject is an error here, not a file the
 * operator finds broken at upload.
 */
export function agentTemplateFromAgent(input: AgentTemplateExportInput): AgentTemplateManifest {
  const i = input.identity;
  const optional = {
    short_description: present(i?.shortDescription),
    long_description: present(i?.longDescription),
    instructions: present(i?.instructions),
    language: present(i?.language),
    persona: i?.persona ?? undefined,
    quality: i?.quality ?? undefined,
  };
  const entry = {
    id: templateIdFromSlug(input.slug),
    archetype: input.archetype,
    name: present(i?.displayName) ?? input.name,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    capabilities: [...input.capabilities],
  } as AgentTemplateManifest;
  const read = readAgentTemplates([entry], 'agent-template');
  if ('error' in read) throw new AgentTemplateExportError(input.slug, read.error);
  return entry;
}

/** The download: an `agent_templates:` block holding the one entry. */
export function agentTemplateYaml(entry: AgentTemplateManifest): string {
  return stringifyYaml({ agent_templates: [entry] });
}
