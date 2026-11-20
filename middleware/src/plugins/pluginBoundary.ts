import { effectiveKind, isInstallableKind, type PluginKind } from '../api/admin-v1.js';

/**
 * Spec 2042 §5.10, ADR-0014 — the agent/plugin boundary, checked when a
 * package enters the instance (upload, Hub download, install).
 *
 * Only agents are actors. A plugin delivers capabilities, a channel, a model,
 * an archetype, a system module or agent templates; it never has a persona,
 * a speaker or an identity of its own. A manifest that declares one is
 * refused, and so is a package of the retired kind `agent` (criterion 15).
 *
 * Allowed on purpose:
 *   - an `agent_templates:` block (and kind `agent-template`): identity and
 *     personality there are inactive metadata the operator turns into an
 *     agent;
 *   - a channel plugin transporting several agents' bots: the identities are
 *     the kernel's, the plugin only carries messages;
 *   - `playbook:` — when to use a capability, read by the calling agent.
 *
 * Checked at ingest only, never when the catalog loads at boot: a package
 * installed before the boundary existed keeps running until its migrated
 * version replaces it (expand step of the plugin release train).
 */

export type BoundaryViolationCode =
  | 'package.retired_kind'
  | 'package.persona_declared';

export interface BoundaryViolation {
  readonly code: BoundaryViolationCode;
  readonly message: string;
  /** Where in the manifest, e.g. `persona`, `skills[0]`, `AGENT.md`. */
  readonly field: string;
  /** What the client needs to say it in the operator's locale. */
  readonly params: Readonly<Record<string, string>>;
}

export interface BoundaryCheckInput {
  readonly pluginId: string;
  readonly kind: PluginKind;
  /** The parsed manifest document. */
  readonly manifest: unknown;
  /** Whether the package root holds an `AGENT.md` / `agent.md` (the persona
   *  file of the retired agent plugins). */
  readonly hasAgentMd: boolean;
  /** The kind of the version installed on this instance, if any. An update
   *  of an installed `agent` package is still let in under that kind until
   *  the release train moved it; no other package becomes one. */
  readonly installedKind: PluginKind | undefined;
}

/** Manifest keys that give a package a persona or a voice of its own. */
const PERSONA_KEYS = ['persona', 'speaker', 'personality', 'system_prompt'] as const;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The first boundary violation of a package, or `undefined` when it may
 * enter. Pure, so every rule is asserted directly in tests.
 */
export function checkPluginBoundary(input: BoundaryCheckInput): BoundaryViolation | undefined {
  if (!isInstallableKind(input.kind) && input.installedKind !== input.kind) {
    return {
      code: 'package.retired_kind',
      field: 'identity.kind',
      params: { pluginId: input.pluginId },
      message:
        "kind 'agent' is retired: a plugin delivers capabilities and may ship agent templates, never an agent of its own (spec 2042 §5.10)",
    };
  }
  // A package of the retired kind that is already installed carries its
  // persona until it is migrated; everything below is for every other kind.
  if (input.kind === 'agent') return undefined;

  const doc = asRecord(input.manifest) ?? {};
  const identity = asRecord(doc['identity']) ?? {};
  for (const key of PERSONA_KEYS) {
    if (doc[key] !== undefined && doc[key] !== null) return personaViolation(input.pluginId, key);
    if (identity[key] !== undefined && identity[key] !== null) return personaViolation(input.pluginId, `identity.${key}`);
  }
  // `prompt_partial` skills are the role-and-tone prompt of a model loop of
  // the plugin's own: the persona of the retired agent plugins.
  const skills = Array.isArray(doc['skills']) ? doc['skills'] : [];
  for (const [i, s] of skills.entries()) {
    if (asRecord(s)?.['kind'] === 'prompt_partial') return personaViolation(input.pluginId, `skills[${String(i)}]`);
  }
  if (input.hasAgentMd && effectiveKind(input.kind) !== 'agent-template') {
    return personaViolation(input.pluginId, 'AGENT.md');
  }
  return undefined;
}

function personaViolation(id: string, where: string): BoundaryViolation {
  return {
    code: 'package.persona_declared',
    field: where,
    params: { pluginId: id, field: where },
    message: `a plugin has no persona, speaker or identity of its own ('${where}'); identity and personality belong to an agent, or to an agent template as inactive presets (spec 2042 §5.10)`,
  };
}
