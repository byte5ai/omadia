/**
 * Agent identity → system prompt (#914 follow-up).
 *
 * The identity's authored text, its persona axes, its boundaries and its
 * sycophancy level are four different things an operator sets in four
 * different controls. The agent speaks with ONE prompt. This module is the
 * single place that turns the first into the second.
 *
 * IT COMPILES NOTHING ITSELF. Every section comes from the compiler that
 * already owns it — `composePersonaSection` (the delta math against the model
 * family), `compileBoundariesSection` (the kemia preset library),
 * `compileSycophancyGuard` (the anti-flattery guard). Re-implementing any of
 * them here would fork the behaviour between a deployed agent and the
 * Builder's preview of the same settings, which is exactly the drift the
 * builder's own parity test exists to prevent.
 *
 * ORDER IS THE CONTRACT: instructions → persona → boundaries → sycophancy.
 * It mirrors `dynamicAgentRuntime`'s `[header, persona, boundaries,
 * sycophancy, skill]` for sub-agents: who you are, how you sound, what you
 * must not do, how not to flatter. Identity text takes the header slot
 * because it is the operator's own words about this agent.
 *
 * EMPTY IN, EMPTY OUT. An identity with nothing authored compiles to `''`,
 * and the caller stores NULL — which is what makes the platform-wide
 * assistant identity apply unchanged to every agent that never used this.
 */

import { isModelRef } from '@omadia/orchestrator';
import type { ModelPolicy } from '@omadia/plugin-api';

import { compileBoundariesSection } from '../plugins/builder/boundaryPresets.js';
import type {
  PersonaConfig,
  QualityConfig,
} from '../plugins/builder/agentSpec.js';
import type {
  AgentIdentityComposedPrompt,
  AgentIdentityRecord,
} from '../platform/agentIdentityStore.js';
import { composePersonaSection } from '../plugins/personaCompose.js';
import {
  inferFamilyFromModel,
  type PersonaModelFamily,
} from '../plugins/personaDelta.js';
import { compileSycophancyGuard } from '../plugins/sycophancyGuard.js';

export interface ComposeAgentIdentityPromptInput {
  /** The operator's own text about this agent. */
  readonly instructions: string | null;
  readonly persona: PersonaConfig | null;
  readonly quality: QualityConfig | null;
  /** Which model family the persona deltas are computed against. */
  readonly family: PersonaModelFamily;
}

export interface ComposedAgentIdentityPrompt {
  /** The assembled prompt, or `null` when nothing was authored. */
  readonly text: string | null;
  /** Boundary preset ids this build could not resolve. Surfaced to the
   *  operator rather than dropped in silence: a preset that vanished from the
   *  library is a rule the agent stopped following. */
  readonly droppedBoundaryPresets: readonly string[];
}

export function composeAgentIdentityPrompt(
  input: ComposeAgentIdentityPromptInput,
): ComposedAgentIdentityPrompt {
  const sections: string[] = [];

  const instructions = input.instructions?.trim() ?? '';
  if (instructions.length > 0) sections.push(instructions);

  const persona = composePersonaSection({
    persona: input.persona ?? undefined,
    family: input.family,
  });
  if (persona.length > 0) sections.push(persona);

  const boundaries = compileBoundariesSection(
    input.quality?.boundaries?.presets ?? [],
    input.quality?.boundaries?.custom ?? [],
  );
  if (boundaries.text.length > 0) sections.push(boundaries.text);

  const sycophancy = compileSycophancyGuard(input.quality?.sycophancy);
  if (sycophancy.length > 0) sections.push(sycophancy);

  return {
    text: sections.length > 0 ? sections.join('\n\n') : null,
    droppedBoundaryPresets: boundaries.droppedIds,
  };
}

/**
 * Which persona family an agent's configured model belongs to.
 *
 * Deliberately a re-export of the delta module's own mapper rather than a second
 * `includes('haiku')` chain: the family decides which axes are emitted at
 * all, and two mappers disagreeing would mean the preview and the running
 * agent describe different characters.
 */
export { inferFamilyFromModel } from '../plugins/personaDelta.js';

/** The agent facts the family choice reads — an orchestrator `AgentRow`
 *  satisfies it structurally. */
export interface AgentPersonaFamilySource {
  readonly modelRouting?: Record<string, unknown> | null;
  readonly modelPolicy?: ModelPolicy;
}

/**
 * Which persona family this agent's persona deltas are computed against.
 *
 * `model_routing.main` is the operator's per-agent model choice; without one
 * the agent runs on the platform default, which this module does not know —
 * and {@link inferFamilyFromModel} answers `sonnet` for an unknown id, the
 * documented safe middle ground for the delta math.
 */
function agentPersonaFamily(agent: AgentPersonaFamilySource): PersonaModelFamily {
  // #1033 — an explicit primary in the model policy outranks model_routing.
  const primary = agent.modelPolicy?.primary;
  if (primary !== undefined && isModelRef(primary)) return inferFamilyFromModel(primary.model);
  const main = agent.modelRouting?.['main'];
  return inferFamilyFromModel(typeof main === 'string' ? main : '');
}

/**
 * #1033 — EVERY family the agent may speak with: the primary's (see above)
 * plus the fallback's when the policy names one. The persona is compiled for
 * each, so a cross-family fallback never runs on a prompt whose deltas were
 * computed against the other family. The primary's family comes first.
 */
export function agentPersonaFamilies(
  agent: AgentPersonaFamilySource,
): readonly PersonaModelFamily[] {
  const primary = agentPersonaFamily(agent);
  const fallback = agent.modelPolicy?.fallback;
  if (fallback !== undefined && isModelRef(fallback)) {
    const fam = inferFamilyFromModel(fallback.model);
    if (fam !== primary) return [primary, fam];
  }
  return [primary];
}

/**
 * Compile the identity prompt for every family in `families`; the FIRST
 * family is the primary and becomes `text`/`family`, the map carries all.
 */
export function composeForFamilies(
  input: { instructions: string | null; persona: PersonaConfig | null; quality: QualityConfig | null },
  families: readonly PersonaModelFamily[],
): { primary: ComposedAgentIdentityPrompt; family: PersonaModelFamily; byFamily: Record<string, string> } {
  const byFamily: Record<string, string> = {};
  let primary: ComposedAgentIdentityPrompt | undefined;
  for (const family of families) {
    const composed = composeAgentIdentityPrompt({ ...input, family });
    if (!primary) primary = composed;
    if (composed.text !== null) byFamily[family] = composed.text;
  }
  const first = families[0] ?? 'sonnet';
  return { primary: primary ?? composeAgentIdentityPrompt({ ...input, family: first }), family: first, byFamily };
}

// ---------------------------------------------------------------------------
// Boot-time recompose (#1100)
// ---------------------------------------------------------------------------

/** Structural subset of `AgentIdentityStore` the boot recompose needs. */
export interface IdentityRecomposeStore {
  listAll(): Promise<readonly AgentIdentityRecord[]>;
  recompose(
    agentId: string,
    composed: AgentIdentityComposedPrompt,
  ): Promise<AgentIdentityRecord | undefined>;
}

export interface RecomposeStaleIdentitiesDeps {
  readonly identityStore: IdentityRecomposeStore;
  /** The orchestrator's `ConfigStore`; `undefined` while that plugin is not
   *  active, in which case there is no agent to compile against. */
  readonly agentStore:
    | {
        listAgents(): Promise<
          readonly (AgentPersonaFamilySource & { readonly id: string })[]
        >;
      }
    | undefined;
  /** Rebuilt once when at least one stored prompt changed. */
  readonly registry: { reload(): Promise<unknown> } | undefined;
  readonly log: (message: string) => void;
}

export interface RecomposeStaleIdentitiesResult {
  readonly refreshed: number;
  readonly failed: number;
}

/** Same entries, key order ignored (jsonb does not keep insertion order). */
function sameByFamily(
  stored: Readonly<Record<string, string>> | undefined,
  compiled: Readonly<Record<string, string>>,
): boolean {
  const a = stored ?? {};
  const keys = Object.keys(compiled);
  return (
    Object.keys(a).length === keys.length &&
    keys.every((k) => a[k] === compiled[k])
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recompile every stored identity prompt against the CURRENT compilers.
 *
 * `agent_identities.composed_prompt` is a write-time cache (migration 0053):
 * the registry speaks with whatever the last save compiled. A compiler change
 * — the #1100 boundary precedence clause, the #1101 custom-line wording —
 * would otherwise reach an agent only after an operator edits and re-saves it,
 * and the identity form's Save button stays disabled until something is dirty.
 *
 * Same semantics as the model-policy recompose: only the compiled prompt is
 * written, `revision` is NOT bumped (nothing the operator authored changed,
 * so the Teams package did not either). A row whose prompt already matches is
 * left alone, so the pass is idempotent and a steady-state boot writes
 * nothing. Runs before the HTTP listener, so no identity save can race it.
 *
 * NEVER THROWS. A row that fails is logged and counted; boot continues on the
 * stale prompt for that one agent rather than not at all.
 */
export async function recomposeStaleIdentities(
  deps: RecomposeStaleIdentitiesDeps,
): Promise<RecomposeStaleIdentitiesResult> {
  const tag = '[agent-identity] boot recompose';
  if (!deps.agentStore) {
    deps.log(`${tag} skipped — agent store not available (orchestrator inactive)`);
    return { refreshed: 0, failed: 0 };
  }
  let identities: readonly AgentIdentityRecord[];
  let agents: readonly (AgentPersonaFamilySource & { readonly id: string })[];
  try {
    [identities, agents] = await Promise.all([
      deps.identityStore.listAll(),
      deps.agentStore.listAgents(),
    ]);
  } catch (err) {
    deps.log(`${tag} skipped — could not list identities/agents: ${errorMessage(err)}`);
    return { refreshed: 0, failed: 0 };
  }
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  let refreshed = 0;
  let failed = 0;
  for (const identity of identities) {
    const agent = agentsById.get(identity.agentId);
    if (!agent) continue;
    try {
      const compiled = composeForFamilies(
        {
          instructions: identity.instructions,
          persona: identity.persona,
          quality: identity.quality,
        },
        agentPersonaFamilies(agent),
      );
      if (
        (identity.composed.text ?? null) === (compiled.primary.text ?? null) &&
        sameByFamily(identity.composed.byFamily, compiled.byFamily)
      ) {
        continue;
      }
      // The save path tells the operator; unattended, the log is the only
      // trace that the rewritten prompt no longer carries that rule.
      const dropped = compiled.primary.droppedBoundaryPresets;
      if (dropped.length > 0) {
        deps.log(
          `${tag} agent ${identity.agentId}: boundary preset(s) no longer in the library: ${dropped.join(', ')}`,
        );
      }
      await deps.identityStore.recompose(identity.agentId, {
        text: compiled.primary.text,
        family: compiled.family,
        byFamily: compiled.byFamily,
      });
      refreshed += 1;
    } catch (err) {
      failed += 1;
      deps.log(`${tag} failed for agent ${identity.agentId}: ${errorMessage(err)}`);
    }
  }
  if (refreshed > 0 && deps.registry) {
    try {
      await deps.registry.reload();
    } catch (err) {
      deps.log(`${tag} registry reload failed: ${errorMessage(err)}`);
    }
  }
  deps.log(
    `${tag}: ${String(refreshed)} of ${String(identities.length)} stored prompt(s) refreshed` +
      (failed > 0 ? `, ${String(failed)} failed` : ''),
  );
  return { refreshed, failed };
}
