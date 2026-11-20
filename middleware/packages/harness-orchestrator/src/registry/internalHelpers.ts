/**
 * #2050 — DB sub-agents are the agent's internal helpers (spec 2042 §5.2 row
 * "DB sub-agents", §5.6, INV-1/INV-2).
 *
 * A helper (`agent_subagents` row, tool `ask_<name>`) does part of ONE agent's
 * work on its own (often cheaper) model, without the conversation. It has no
 * name or persona towards people; its output is the agent's own work. Its
 * envelope is a subset of its agent's: the agent's tools, the agent's model
 * policy, the agent's budget, nothing added.
 *
 * This module holds the rules both write paths (Agent Builder routes) and the
 * runtime (sub-agent materialisation) apply, so the two cannot drift:
 *
 *   - {@link HelperRefusalError} — the typed refusal a route answers with.
 *   - {@link helperToolNameConflicts} / {@link assertHelperNameFree} —
 *     collision-free `ask_<name>` tool names (#1796).
 *   - {@link helperModelVerdict} / {@link assertHelperModelAllowed} — the
 *     helper's model must be one the agent's model policy allows.
 *   - {@link mcpGrantHeldBy} — an MCP grant of a helper must be one its agent
 *     holds itself.
 *   - {@link INTERNAL_HELPER_CONTRACT} — what the helper's own model is told.
 */

import { resolveModelRef, type ModelClass, type ModelInfo } from '@omadia/llm-provider';
import type { ModelPolicy, ModelRef } from '@omadia/plugin-api';

import { ConfigValidationError } from './configStore.js';
import { isModelRef } from './modelPolicy.js';

/** Machine codes of a refused helper write, stable for the UI's copy. */
export type HelperRefusalCode =
  | 'helper_name_collision'
  | 'helper_grant_not_held_by_agent'
  | 'helper_model_not_allowed';

/**
 * A helper write the rules refuse. Extends {@link ConfigValidationError} so a
 * caller that only knows that class still answers 409; the Agent Builder
 * routes answer with `code` as well.
 */
export class HelperRefusalError extends ConfigValidationError {
  readonly code: HelperRefusalCode;

  constructor(code: HelperRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HelperRefusalError';
    this.code = code;
  }
}

/**
 * Appended to every helper's system prompt, whatever the skill or override
 * says: the helper answers its agent, not a person, and never presents itself.
 */
export const INTERNAL_HELPER_CONTRACT =
  'You work as an internal helper inside one agent. Your answer goes back to that ' +
  'agent, which uses it as part of its own reply; no person reads it directly. Do ' +
  'not introduce yourself, do not sign, and do not refer to yourself by a name or ' +
  'role. Answer the question directly.';

// ── tool names ─────────────────────────────────────────────────────────────

/** `ask_<slug>` constrained to Anthropic's tool-name charset (`[a-zA-Z0-9_-]{1,64}`). */
export function helperToolName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const full = `ask_${slug || 'subagent'}`;
  return full.length <= 64 ? full : full.slice(0, 64);
}

export interface NamedHelper {
  readonly id: string;
  readonly name: string;
}

export interface HelperNameConflict {
  readonly helperId: string;
  readonly toolName: string;
  /** Another helper of the same agent maps to the same tool name … */
  readonly withHelperIds: readonly string[];
  /** … or the agent already has another tool of that name. */
  readonly withAgentTool: boolean;
}

/**
 * Every helper whose tool name is not unique: shared with another helper of the
 * same agent, or with one of the agent's other tools (`reservedToolNames`).
 * Order-independent on purpose: ALL members of a colliding group are reported,
 * so nothing depends on which row the database returned first and no helper
 * silently shadows another.
 */
export function helperToolNameConflicts(
  helpers: readonly NamedHelper[],
  reservedToolNames: ReadonlySet<string>,
): HelperNameConflict[] {
  const byTool = new Map<string, string[]>();
  for (const h of helpers) {
    const tool = helperToolName(h.name);
    byTool.set(tool, [...(byTool.get(tool) ?? []), h.id]);
  }
  const out: HelperNameConflict[] = [];
  for (const h of helpers) {
    const toolName = helperToolName(h.name);
    const withHelperIds = (byTool.get(toolName) ?? []).filter((id) => id !== h.id);
    const withAgentTool = reservedToolNames.has(toolName);
    if (withHelperIds.length > 0 || withAgentTool) {
      out.push({ helperId: h.id, toolName, withHelperIds, withAgentTool });
    }
  }
  return out;
}

/**
 * Save-time check of one helper's name against its siblings (every helper of
 * the same agent, enabled or not: a disabled one can be switched on later) and
 * the agent's other tools.
 */
export function assertHelperNameFree(args: {
  readonly name: string;
  /** The helper being renamed; absent on create. */
  readonly selfId?: string;
  readonly siblings: readonly NamedHelper[];
  readonly reservedToolNames: ReadonlySet<string>;
}): void {
  const toolName = helperToolName(args.name);
  const clash = args.siblings.find(
    (s) => s.id !== args.selfId && helperToolName(s.name) === toolName,
  );
  if (clash) {
    throw new HelperRefusalError(
      'helper_name_collision',
      `the helper name "${args.name}" maps to the tool "${toolName}", which the helper "${clash.name}" of this agent already uses; choose a different name`,
    );
  }
  if (args.reservedToolNames.has(toolName)) {
    throw new HelperRefusalError(
      'helper_name_collision',
      `the helper name "${args.name}" maps to the tool "${toolName}", which this agent already has as another tool; choose a different name`,
    );
  }
}

// ── model policy ───────────────────────────────────────────────────────────

const CLASS_RANK: Readonly<Record<ModelClass, number>> = { fast: 0, balanced: 1, frontier: 2 };

export type HelperModelVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

function refInfo(ref: ModelRef): ModelInfo | undefined {
  return resolveModelRef(ref.model, { defaultProvider: ref.provider });
}

/**
 * Is `helperModel` a model the agent's policy allows? (spec §5.6: "a model the
 * agent's policy allows (it may be cheaper)").
 *
 *   - empty ref ⇒ allowed: the helper inherits, see {@link helperDefaultModelRef}.
 *   - policy `auto` ⇒ allowed: the agent may use any model the host serves, and
 *     the provider check of `validateModelRef` already ran on write.
 *   - explicit primary ⇒ the helper's model must be on the provider of the
 *     primary or of an explicit fallback, and of a class no stronger than the
 *     primary's (fast < balanced < frontier): a helper may be cheaper than its
 *     agent, never stronger.
 */
export function helperModelVerdict(
  helperModel: string | null | undefined,
  policy: ModelPolicy | undefined,
  activeProvider?: string,
): HelperModelVerdict {
  const ref = helperModel?.trim() ?? '';
  if (ref === '' || !policy || !isModelRef(policy.primary)) return { allowed: true };
  const primary = policy.primary;
  const providers = new Set<string>([primary.provider]);
  if (isModelRef(policy.fallback)) providers.add(policy.fallback.provider);
  const info = resolveModelRef(ref, activeProvider ? { defaultProvider: activeProvider } : {});
  if (!info) {
    return { allowed: false, reason: `the model "${ref}" is not served by any installed provider` };
  }
  if (!providers.has(info.provider)) {
    return {
      allowed: false,
      reason: `the agent's model policy allows models of ${[...providers].join(', ')}, not "${ref}" (${info.provider})`,
    };
  }
  const primaryInfo = refInfo(primary);
  if (primaryInfo && CLASS_RANK[info.class] > CLASS_RANK[primaryInfo.class]) {
    return {
      allowed: false,
      reason: `"${ref}" is a ${info.class} model, stronger than the agent's own ${primaryInfo.class} model "${primary.model}"; a helper may run on the same or a cheaper class`,
    };
  }
  return { allowed: true };
}

export function assertHelperModelAllowed(
  helperModel: string | null | undefined,
  policy: ModelPolicy | undefined,
  activeProvider?: string,
): void {
  const verdict = helperModelVerdict(helperModel, policy, activeProvider);
  if (!verdict.allowed) throw new HelperRefusalError('helper_model_not_allowed', verdict.reason);
}

/**
 * The model a helper without its own model runs on. The platform default
 * (`defaultModel`, a class ref) unless the agent pins an explicit primary of a
 * weaker class on the provider the helper runs on: then the helper inherits
 * that primary, so "inherit" never means "stronger than the agent".
 */
export function helperDefaultModelRef(
  defaultModel: string,
  policy: ModelPolicy | undefined,
  runProvider: string | undefined,
): string {
  if (!policy || !isModelRef(policy.primary)) return defaultModel;
  const primary = policy.primary;
  if (runProvider !== undefined && primary.provider !== runProvider) return defaultModel;
  const primaryInfo = refInfo(primary);
  const defaultInfo = resolveModelRef(defaultModel, runProvider ? { defaultProvider: runProvider } : {});
  if (!primaryInfo || !defaultInfo) return defaultModel;
  return CLASS_RANK[defaultInfo.class] > CLASS_RANK[primaryInfo.class] ? primaryInfo.id : defaultModel;
}

// ── out of service ─────────────────────────────────────────────────────────

/** Why an enabled helper does not run as configured (#2050, fail loud). */
export interface HelperOutOfService {
  readonly code: 'helper_model_not_allowed' | 'helper_name_conflict';
  readonly reason: string;
}

/**
 * The verdict the runtime applies to each ENABLED helper of one agent, for the
 * admin UI: a name collision (the helper is not built) or a model the agent's
 * policy does not allow (the helper's tool refuses every call). The same rules
 * as `buildSubAgentDomainTools`, so the Agent Builder shows exactly what the
 * runtime does after a deploy, not a guess. Helpers without an entry run.
 */
export function helpersOutOfService(
  helpers: readonly (NamedHelper & { readonly model: string | null; readonly status: string })[],
  input: {
    readonly policy: ModelPolicy | undefined;
    readonly activeProvider: string | undefined;
    readonly reservedToolNames: ReadonlySet<string>;
  },
): Map<string, HelperOutOfService> {
  const enabled = helpers.filter((h) => h.status === 'enabled');
  const out = new Map<string, HelperOutOfService>();
  for (const c of helperToolNameConflicts(enabled, input.reservedToolNames)) {
    out.set(c.helperId, {
      code: 'helper_name_conflict',
      reason: `its tool name "${c.toolName}" collides with ${
        c.withAgentTool ? 'another tool of this agent' : 'another helper of this agent'
      }`,
    });
  }
  for (const h of enabled) {
    if (out.has(h.id)) continue;
    const verdict = helperModelVerdict(h.model, input.policy, input.activeProvider);
    if (!verdict.allowed) out.set(h.id, { code: 'helper_model_not_allowed', reason: verdict.reason });
  }
  return out;
}

// ── capability subset ──────────────────────────────────────────────────────

/** The fields of a tool grant the subset check reads. */
export interface GrantLike {
  readonly agentId: string | null;
  readonly subAgentId: string | null;
  readonly toolKind: 'native' | 'mcp';
  readonly toolRef: string;
  readonly mcpServerId: string | null;
}

/** Bare MCP tool name of a grant ref (`<server>:<tool>` or `<tool>`). */
function bareMcpTool(toolRef: string, serverName: string | undefined): string {
  if (serverName !== undefined && toolRef.startsWith(`${serverName}:`)) {
    return toolRef.slice(serverName.length + 1);
  }
  const idx = toolRef.indexOf(':');
  return idx >= 0 ? toolRef.slice(idx + 1) : toolRef;
}

/**
 * Does the agent hold the MCP tool `(mcpServerId, toolRef)` itself, i.e. is
 * there an agent-level grant (no helper) for the same server and tool among
 * `agentGrants`? Compared on the bare tool name, so a `<server>:`-prefixed
 * legacy ref and the normalized bare ref match.
 */
export function mcpGrantHeldBy(
  agentGrants: readonly GrantLike[],
  mcpServerId: string,
  toolRef: string,
  serverName?: string,
): boolean {
  const wanted = bareMcpTool(toolRef, serverName);
  return agentGrants.some(
    (g) =>
      g.subAgentId === null &&
      g.agentId !== null &&
      g.toolKind === 'mcp' &&
      g.mcpServerId === mcpServerId &&
      bareMcpTool(g.toolRef, serverName) === wanted,
  );
}
