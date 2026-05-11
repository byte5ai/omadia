import { parseAgentSpec, type AgentSpec } from './agentSpec.js';
import { emptyAgentSpec, type AgentSpecSkeleton } from './types.js';

/**
 * Phase 2.4 — reconstruct a Builder `AgentSpec` from the assets carried by
 * a Profile-Bundle (`profile-bundle-v1.md`).
 *
 * Two import paths:
 *
 *   1. Spec-aware: bundles produced by the Builder snapshot pipeline
 *      embed `knowledge/spec.json` (a verbatim dump of the canonical
 *      AgentSpec). When present, we round-trip through `parseAgentSpec`
 *      so any schema drift between exporter and importer is rejected
 *      hard — you should NOT import a bundle whose spec your local
 *      Builder can't validate.
 *
 *   2. Source-only: legacy / hand-authored bundles ship only `agent.md`
 *      (no spec.json). We seed an empty spec with the bundle's name as
 *      identity placeholder and the rendered agent.md as `skill.role`
 *      so the operator gets something visible in the Builder UI. The
 *      operator must then complete identity (`id`, `version`, `category`)
 *      before re-installing.
 */
export interface ReconstructSpecInput {
  bundleAgentMd: Buffer;
  bundleSpecJson: Buffer | null;
  fallbackName: string;
}

export interface ReconstructSpecResult {
  spec: AgentSpecSkeleton;
  name: string;
  /** Path the spec was reconstructed from. Surfaced in import response so
   *  the operator can tell whether identity fields need filling in. */
  source: 'spec_json' | 'agent_md_fallback';
}

export class SpecReconstructError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpecReconstructError';
  }
}

export function reconstructSpecFromBundle(
  input: ReconstructSpecInput,
): ReconstructSpecResult {
  if (input.bundleSpecJson && input.bundleSpecJson.byteLength > 0) {
    let raw: unknown;
    try {
      raw = JSON.parse(input.bundleSpecJson.toString('utf8'));
    } catch (err) {
      throw new SpecReconstructError(
        `spec.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    let parsed: AgentSpec;
    try {
      parsed = parseAgentSpec(raw);
    } catch (err) {
      throw new SpecReconstructError(
        `spec.json failed AgentSpec schema validation: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const name =
      parsed.name && parsed.name.length > 0 ? parsed.name : input.fallbackName;
    return {
      spec: parsed as unknown as AgentSpecSkeleton,
      name,
      source: 'spec_json',
    };
  }

  const skeleton = emptyAgentSpec();
  const role = stripFrontmatter(input.bundleAgentMd.toString('utf8')).trim();
  if (role.length > 0) {
    skeleton.skill = { role };
  }
  return {
    spec: skeleton,
    name: input.fallbackName,
    source: 'agent_md_fallback',
  };
}

/**
 * Strip a leading YAML frontmatter block (delimited by `---` lines) so the
 * markdown body alone can be used as a `skill.role` seed. The Bundle's
 * `agent.md` may contain a frontmatter (Persona-UI Phase 3+ convention),
 * but the `skill.role` field is meant to be plain text — leaving the
 * frontmatter in place would surface as raw YAML in the Builder UI.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const closing = content.indexOf('\n---', 3);
  if (closing === -1) return content;
  const after = content.slice(closing + 4);
  return after.startsWith('\n') ? after.slice(1) : after;
}
