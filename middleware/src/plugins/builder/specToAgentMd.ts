import { stringify as stringifyYaml } from 'yaml';

import { effectivePluginKind } from './agentSpec.js';
import type { AgentSpecSkeleton } from './types.js';

/**
 * Render a builder draft's `AgentSpecSkeleton` into the `agent.md` byte form
 * (YAML frontmatter + markdown body) that Profile Storage keys its snapshots
 * on.
 *
 * This is the bridge serialiser used by `DraftStorageBridge` (OB-83) to
 * mirror builder drafts into `profile_agent_md` so Phase 2.2 snapshots /
 * rollback / diff have a non-empty source. The full spec rides along as
 * `knowledge/spec.json`; this document is the human-readable summary.
 *
 * Spec 2042 §5.10 — a Plugin Builder draft is a capability plugin: the
 * document carries the plugin's identity, kind and playbook, never a persona,
 * quality settings or role instructions (those belong to an agent).
 *
 * Determinism — two calls with identical input produce byte-identical
 * output. yaml.stringify normalises key order; the body is a
 * deterministic concatenation of the playbook fields.
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
  /** Manifest kind of the generated capability plugin. */
  kind: 'integration' | 'tool';
}

interface Frontmatter {
  schema_version: 1;
  identity: FrontmatterIdentity;
}

export function specToAgentMd(input: SpecToAgentMdInput): Buffer {
  const identity: FrontmatterIdentity = {
    id: input.spec.id?.length > 0 ? input.spec.id : input.draftId,
    display_name:
      input.spec.name && input.spec.name.length > 0
        ? input.spec.name
        : input.draftName,
    kind: effectivePluginKind(input.spec),
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

  const body = renderBody(input.spec);

  // yaml.stringify ends with a trailing newline; we add a `---\n` opener
  // and a `---\n\n` closer so the body always starts on its own line.
  const yamlBlock = stringifyYaml(frontmatter);
  const markdown = `---\n${yamlBlock}---\n\n${body}`;
  return Buffer.from(markdown, 'utf8');
}

function renderBody(spec: AgentSpecSkeleton): string {
  const parts: string[] = [];

  const description = spec.description?.trim();
  if (description && description.length > 0) {
    parts.push(`# ${spec.name?.trim() || spec.id}\n\n${description}`);
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
    return '<!-- plugin description not yet authored -->\n';
  }
  return parts.join('\n\n') + '\n';
}
