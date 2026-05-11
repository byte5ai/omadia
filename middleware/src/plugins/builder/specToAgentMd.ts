import { stringify as stringifyYaml } from 'yaml';

import type { AgentSpecSkeleton } from './types.js';

/**
 * Render a builder draft's `AgentSpecSkeleton` into the canonical
 * `agent.md` byte form (YAML frontmatter + markdown body).
 *
 * This is the bridge serialiser used by `DraftStorageBridge` (OB-83) to
 * mirror builder drafts into `profile_agent_md` so Phase 2.2 snapshots /
 * rollback / diff have a non-empty source. Frontmatter shape stays in
 * sync with persona-ui-v1.md §6 and the `responseGuard@1` schema in
 * `plugin-api/src/responseGuard.ts`.
 *
 * Determinism — two calls with identical input produce byte-identical
 * output. yaml.stringify normalises key order; the body is a
 * deterministic concatenation of role / tonality / playbook fields.
 *
 * Out of scope:
 *   - Knowledge files (builder has no knowledge concept yet)
 *   - Reverse parser (frontmatter → spec is the Phase-3.5 follow-up;
 *     Phase 3 reads/writes through `AgentSpec.persona` directly).
 *
 * Phase 3 update (OB-67): the `persona:` block now mirrors here when the
 * spec carries one. Empty axes / templates are omitted; the runtime
 * `personaCompose@1` provider (Phase 4 conditional) consumes the same
 * shape from the frontmatter once it lands.
 */

export interface SpecToAgentMdInput {
  /** Builder draft id; equals the Profile-Storage profile_id by
   *  architecture invariant (HANDOFF Slice 2). */
  draftId: string;
  spec: AgentSpecSkeleton;
  /** Display name from the draft row — preferred over `spec.name` only
   *  when the spec hasn't been touched yet (fresh drafts). */
  draftName: string;
}

interface FrontmatterIdentity {
  id: string;
  display_name: string;
  description?: string;
  category?: string;
  /** OB-77 — Palaia Phase 8 plugin domain. Mirrors manifest.yaml.identity.domain
   *  so a roundtrip through agent.md preserves the field. */
  domain?: string;
  version?: string;
}

interface Frontmatter {
  schema_version: 1;
  identity: FrontmatterIdentity;
  quality?: AgentSpecSkeleton['quality'];
  persona?: AgentSpecSkeleton['persona'];
}

export function specToAgentMd(input: SpecToAgentMdInput): Buffer {
  const identity: FrontmatterIdentity = {
    id: input.spec.id?.length > 0 ? input.spec.id : input.draftId,
    display_name:
      input.spec.name && input.spec.name.length > 0
        ? input.spec.name
        : input.draftName,
  };
  if (input.spec.description && input.spec.description.length > 0) {
    identity.description = input.spec.description;
  }
  if (input.spec.category && input.spec.category.length > 0) {
    identity.category = input.spec.category;
  }
  if (input.spec.domain && input.spec.domain.length > 0) {
    identity.domain = input.spec.domain;
  }
  if (input.spec.version && input.spec.version.length > 0) {
    identity.version = input.spec.version;
  }

  const frontmatter: Frontmatter = {
    schema_version: 1,
    identity,
  };
  if (input.spec.quality && hasQualityContent(input.spec.quality)) {
    frontmatter.quality = input.spec.quality;
  }
  if (input.spec.persona) {
    const compactedPersona = compactPersona(input.spec.persona);
    if (compactedPersona) frontmatter.persona = compactedPersona;
  }

  const body = renderBody(input.spec);

  // yaml.stringify ends with a trailing newline; we add a `---\n` opener
  // and a `---\n\n` closer so the body always starts on its own line.
  const yamlBlock = stringifyYaml(frontmatter);
  const markdown = `---\n${yamlBlock}---\n\n${body}`;
  return Buffer.from(markdown, 'utf8');
}

function hasQualityContent(quality: NonNullable<AgentSpecSkeleton['quality']>): boolean {
  if (quality.sycophancy && quality.sycophancy !== 'off') return true;
  const presets = quality.boundaries?.presets ?? [];
  const custom = quality.boundaries?.custom ?? [];
  return presets.length > 0 || custom.length > 0;
}

/**
 * Drop empty axes (so the YAML doesn't carry `formality: undefined`) and
 * skip the whole block when nothing meaningful is set. Returns `null`
 * when the persona block would be empty after compaction — the caller
 * then omits the frontmatter key entirely.
 */
function compactPersona(
  persona: NonNullable<AgentSpecSkeleton['persona']>,
): NonNullable<AgentSpecSkeleton['persona']> | null {
  const out: NonNullable<AgentSpecSkeleton['persona']> = {};

  if (persona.template && persona.template.length > 0) {
    out.template = persona.template;
  }
  if (persona.custom_notes && persona.custom_notes.trim().length > 0) {
    out.custom_notes = persona.custom_notes.trim();
  }
  if (persona.axes) {
    const compactedAxes: NonNullable<AgentSpecSkeleton['persona']>['axes'] = {};
    let any = false;
    for (const [key, value] of Object.entries(persona.axes)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        (compactedAxes as Record<string, number>)[key] = value;
        any = true;
      }
    }
    if (any) out.axes = compactedAxes;
  }

  if (!out.template && !out.custom_notes && !out.axes) return null;
  return out;
}

function renderBody(spec: AgentSpecSkeleton): string {
  const parts: string[] = [];

  if (spec.skill?.role && spec.skill.role.length > 0) {
    parts.push(`# Role\n\n${spec.skill.role.trim()}`);
  }
  if (spec.skill?.tonality && spec.skill.tonality.length > 0) {
    parts.push(`## Tonality\n\n${spec.skill.tonality.trim()}`);
  }

  const whenTo = spec.playbook?.when_to_use?.trim();
  if (whenTo && whenTo.length > 0) {
    parts.push(`## When to use\n\n${whenTo}`);
  }

  const notFor = spec.playbook?.not_for ?? [];
  if (notFor.length > 0) {
    const bullets = notFor.map((line) => `- ${line.trim()}`).join('\n');
    parts.push(`## Not for\n\n${bullets}`);
  }

  const examples = spec.playbook?.example_prompts ?? [];
  if (examples.length > 0) {
    const bullets = examples.map((line) => `- ${line.trim()}`).join('\n');
    parts.push(`## Example prompts\n\n${bullets}`);
  }

  if (parts.length === 0) {
    // Fresh-draft fallback — keep the body non-empty so downstream
    // markdown processors don't trip on an empty document.
    return '<!-- agent body not yet authored -->\n';
  }
  return parts.join('\n\n') + '\n';
}
