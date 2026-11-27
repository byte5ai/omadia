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
 *      identity placeholder. The agent.md body is not carried over: it is
 *      an agent's role text, and a Plugin Builder draft is a capability
 *      plugin without a persona (spec 2042 §5.10). The operator completes
 *      the plugin in the Builder; the result's `source` says so.
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

  return {
    spec: emptyAgentSpec(),
    name: input.fallbackName,
    source: 'agent_md_fallback',
  };
}

/**
 * #1787/#1788 — the knowledge files a Builder snapshot carries for the draft
 * itself, next to the operator's own knowledge files. `spec.json` is the
 * spec, `slots.json` the slot code (`draft.slots`, a separate column the
 * spec does not contain). Neither is operator knowledge: importers and the
 * rollback route restore them into the draft, not into the knowledge dir.
 */
export const BUNDLE_SPEC_FILE = 'spec.json';
export const BUNDLE_SLOTS_FILE = 'slots.json';

/** `knowledge/slots.json` or `slots.json` → `slots.json`. */
export function bundleKnowledgeBaseName(filename: string): string {
  return filename.startsWith('knowledge/') ? filename.slice('knowledge/'.length) : filename;
}

export function isDraftSourceFile(filename: string): boolean {
  const base = bundleKnowledgeBaseName(filename);
  return base === BUNDLE_SPEC_FILE || base === BUNDLE_SLOTS_FILE;
}

/**
 * Parses `slots.json` into slot key → source. A bundle without the file
 * (exported before #1787) yields `null`: the caller keeps the slots it has.
 * Anything that is not an object of strings is refused, never half-applied.
 */
export function parseBundleSlots(content: Buffer | null | undefined): Record<string, string> | null {
  if (!content || content.byteLength === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch (err) {
    throw new SpecReconstructError(
      `slots.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecReconstructError('slots.json must be an object of slot key → source');
  }
  const slots: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new SpecReconstructError(`slots.json: slot '${key}' is not a string`);
    }
    slots[key] = value;
  }
  return slots;
}
