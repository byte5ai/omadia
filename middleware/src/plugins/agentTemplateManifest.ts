// The `agent_templates:` block of a manifest (spec 2042 §5.10, ADR-0014).
//
// An agent template is a preset of identity, personality and suggested
// capabilities for an agent of an existing archetype. It is INACTIVE
// metadata: nothing in it runs, it grants nothing and it is never an
// actor. Only the operator turns a template into an agent, in the Agent
// Builder; the kernel serves the template as a prefill of that form
// (`GET /api/v1/admin/agent-templates/prefill`).
//
// The block is read strictly, like the `archetype:` block: a template the
// kernel cannot read in full rejects the manifest, so an author learns at
// upload that a field was dropped, instead of an operator later creating an
// agent from a preset that is silently narrower than its package says.

import { z } from 'zod';

import { isArchetypeId, STANDARD_ARCHETYPE } from '@omadia/orchestrator';

import type { PluginKind } from '../api/admin-v1.js';
import { effectiveKind } from '../api/admin-v1.js';
import { PersonaConfigSchema, QualityConfigSchema } from './builder/agentSpec.js';

/** Kinds whose packages may carry templates besides what they deliver:
 *  capability plugins (a template that uses the capability), archetype
 *  plugins (presets for agents of their archetype) and template packages. */
const TEMPLATE_CARRYING_KINDS: ReadonlySet<PluginKind> = new Set<PluginKind>([
  'integration',
  'tool',
  'skill',
  'archetype',
  'agent-template',
]);

/** More presets than this in one package is a catalog, not a template set. */
const MAX_TEMPLATES_PER_PLUGIN = 50;
const MAX_SUGGESTED_CAPABILITIES = 50;

const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

const text = (max: number) => z.string().trim().min(1).max(max);

/** The limits are those of the agent create and identity routes the
 *  prefill feeds, so a prefill always passes them unchanged. */
export const AgentTemplateSchema = z
  .object({
    id: z.string().regex(TEMPLATE_ID_PATTERN, 'a lowercase letter, then lowercase letters, digits, hyphens (max 63)'),
    /** The archetype of the agents this preset is for; `standard` when absent. */
    archetype: z.string().refine(isArchetypeId, 'an archetype id').optional(),
    /** The proposed name of the agent. */
    name: text(120),
    short_description: text(80).optional(),
    long_description: text(4000).optional(),
    /** The opening of the agent's system prompt: its role and how it works. */
    instructions: text(20_000).optional(),
    language: z.string().trim().regex(LANGUAGE_TAG_PATTERN, 'a BCP 47 language tag such as "de" or "en-GB"').optional(),
    persona: PersonaConfigSchema.optional(),
    quality: QualityConfigSchema.optional(),
    /** Plugin ids of the capabilities the template suggests granting. Only
     *  a suggestion: the operator grants, and installing grants nothing
     *  (INV-8). */
    capabilities: z.array(text(214)).max(MAX_SUGGESTED_CAPABILITIES).optional(),
  })
  .strict();

export type AgentTemplateManifest = z.infer<typeof AgentTemplateSchema>;

/** A template as the catalog keeps it: the archetype is always resolved. */
export type AgentTemplate = Omit<AgentTemplateManifest, 'archetype' | 'capabilities'> & {
  readonly archetype: string;
  readonly capabilities: readonly string[];
};

export type AgentTemplatesRead =
  | { readonly templates: readonly AgentTemplate[] }
  | { readonly error: string };

/**
 * Read the `agent_templates:` block of a manifest of `kind`. `error` says
 * why the manifest is rejected; an absent block reads as no templates.
 */
export function readAgentTemplates(raw: unknown, kind: PluginKind): AgentTemplatesRead {
  const isTemplatePackage = effectiveKind(kind) === 'agent-template';
  if (raw === undefined || raw === null) {
    return isTemplatePackage
      ? { error: "a plugin of kind 'agent-template' needs an `agent_templates:` list with at least one template" }
      : { templates: [] };
  }
  if (!TEMPLATE_CARRYING_KINDS.has(effectiveKind(kind))) {
    return { error: `\`agent_templates:\` is not read for identity.kind '${kind}'; capability, archetype and agent-template plugins carry templates` };
  }
  if (!Array.isArray(raw)) return { error: '`agent_templates:` must be a list' };
  if (raw.length === 0 && isTemplatePackage) {
    return { error: "a plugin of kind 'agent-template' needs at least one template" };
  }
  if (raw.length > MAX_TEMPLATES_PER_PLUGIN) {
    return { error: `\`agent_templates:\` holds ${String(raw.length)} templates; at most ${String(MAX_TEMPLATES_PER_PLUGIN)}` };
  }
  const templates: AgentTemplate[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const parsed = AgentTemplateSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
      return { error: `agent_templates[${String(i)}]${where}: ${issue?.message ?? 'invalid'}` };
    }
    if (seen.has(parsed.data.id)) {
      return { error: `agent_templates[${String(i)}].id '${parsed.data.id}' is declared twice` };
    }
    seen.add(parsed.data.id);
    const { archetype, capabilities, ...rest } = parsed.data;
    templates.push({
      ...rest,
      archetype: archetype ?? STANDARD_ARCHETYPE,
      capabilities: [...new Set(capabilities ?? [])],
    });
  }
  return { templates };
}
