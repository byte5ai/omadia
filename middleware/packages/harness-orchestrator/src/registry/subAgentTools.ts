import { isClassRef, type EffortLevel, type LlmProvider } from '@omadia/llm-provider';
import type { LocalSubAgentTool, ModelPolicy } from '@omadia/plugin-api';
import { ToolRefusalError } from '@omadia/plugin-api';

import { createCliSubAgent } from '../cliSubAgent.js';
import { LocalSubAgent } from '../localSubAgent.js';
import { subAgentEffortFor } from '../subAgentEffort.js';
import { resolveConfiguredModel, resolveModelIdForProvider } from './agentRuntime.js';
import { sortBySpecName } from '../toolOrdering.js';
import type {
  McpManager} from '../mcp/mcpClient.js';
import {
  mcpToolToLocalSubAgentTool,
  type McpServerConfig,
} from '../mcp/mcpClient.js';
import {
  createDomainTool,
  type Askable,
  type DomainTool,
} from '../tools/domainQueryTool.js';

import type {
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from './agentGraphStore.js';
import {
  INTERNAL_HELPER_CONTRACT,
  helperDefaultModelRef,
  helperModelVerdict,
  helperToolName,
  helperToolNameConflicts,
  mcpGrantHeldBy,
} from './internalHelpers.js';

/**
 * Agent Builder P2/P4 — materialise an agent's DB-defined sub-agents into
 * orchestrator `DomainTool`s.
 *
 * #2050 — these are the agent's INTERNAL HELPERS (spec 2042 §5.2, §5.6): no
 * name or persona towards people, their output is the agent's own work, and
 * their envelope is a subset of the agent's (tools, model policy, budget). See
 * `internalHelpers.ts` for the shared rules.
 *
 * Each enabled `agent_subagents` row becomes a `LocalSubAgent` whose system
 * prompt is its skill body (or an inline override), running on its own model
 * with the tools granted to it (native tools resolved via the orchestrator's
 * registry, MCP tools via the `McpManager`). The sub-agent is wrapped in a
 * `DomainTool` (`ask_<name>`) so the parent orchestrator can delegate to it by
 * tool name — the same mechanism plugin-provided domain agents use.
 *
 * Pure-ish factory: the only side effect is constructing `LocalSubAgent` /
 * MCP-tool closures. Unit-testable by passing a fake client + resolvers.
 */

export interface SubAgentGraph {
  readonly subAgents: readonly SubAgentRow[];
  readonly toolGrants: readonly ToolGrantRow[];
  readonly skills: readonly SkillRow[];
}

export interface SubAgentToolDeps {
  readonly provider: LlmProvider;
  readonly defaultModel: string;
  readonly defaultMaxTokens: number;
  readonly defaultMaxIterations: number;
  /** `SUB_AGENT_EFFORT` — absent = no effort sent (`subAgentEffort.ts`). */
  readonly defaultEffort?: EffortLevel;
  /** #309 recursive Shape 3 — when the host provider is the subscription CLI,
   *  run each DB-defined sub-agent through its own CliChatAgent instead of the
   *  in-process LocalSubAgent. Default false → byte-identical legacy path. */
  readonly hostIsCliProvider?: boolean;
  /** CLI model alias resolver (strip `-cli`). Required only when
   *  hostIsCliProvider is true; defaults to identity otherwise. */
  readonly cliModelAlias?: (model: string) => string;
  /**
   * #1085 — resolves the `claude` binary a CLI sub-agent spawns, per turn.
   * Wired by the kernel (`subAgentToolHydration`) to its `resolveCliBin` rule;
   * absent ⇒ the bare name from PATH, the pre-#1085 behaviour.
   */
  readonly resolveCliBinary?: () => string;
  /** Resolves an MCP server id → connection config (for mcp tool grants). */
  readonly mcpServersById?: ReadonlyMap<string, McpServerConfig>;
  /** Shared MCP connection pool. Required to honour mcp tool grants. */
  readonly mcpManager?: McpManager;
  /** Resolves a native tool name → a sub-agent-callable tool, if available. */
  readonly nativeTool?: (toolRef: string) => LocalSubAgentTool | undefined;
  /** Scan-verdict policy gate (epic #459 W1, issue #454): when it returns
   *  true for (serverId, toolName), the grant is NOT materialized into a
   *  callable tool — a high_risk/scan_failed verdict without a valid ack
   *  must not stay callable just because the grant predates the verdict. */
  readonly blockedMcpGrant?: (serverId: string, toolName: string) => boolean;
  /**
   * #2050 — does the PARENT agent hold this granted capability right now?
   * Asked when the helper is built (a grant its agent lacks is never
   * materialised) and again on EVERY call of the helper's tool, so revoking
   * the agent's grant after materialisation removes the helper's access. The
   * kernel answers from the live registry, not from this build's snapshot.
   * Absent ⇒ native grants pass and an MCP grant needs an agent-level grant
   * for the same server and tool in `graph.toolGrants` (the snapshot).
   */
  readonly parentHolds?: (grant: ToolGrantRow) => boolean;
  /** #2050 — the parent agent's model policy; a helper model it does not
   *  allow is refused (`helperModelVerdict`). Absent ⇒ no policy check. */
  readonly parentModelPolicy?: ModelPolicy;
  /** #2050 — the parent agent's per-call output budget and step cap. A
   *  helper's own `maxTokens`/`maxIterations` never exceed them. */
  readonly parentBudget?: { readonly maxTokens: number; readonly maxIterations: number };
  /** #2050 — names of the parent's OTHER tools (plugin domain tools, native
   *  tools). A helper whose `ask_<name>` collides with one is not built. */
  readonly reservedToolNames?: ReadonlySet<string>;
  readonly log?: (msg: string) => void;
}

export function buildSubAgentDomainTools(
  graph: SubAgentGraph,
  deps: SubAgentToolDeps,
): DomainTool[] {
  const skillsById = new Map(graph.skills.map((s) => [s.id, s]));
  const grantsBySubAgent = new Map<string, ToolGrantRow[]>();
  for (const g of graph.toolGrants) {
    if (!g.subAgentId) continue;
    const list = grantsBySubAgent.get(g.subAgentId);
    if (list) list.push(g);
    else grantsBySubAgent.set(g.subAgentId, [g]);
  }

  const tools: DomainTool[] = [];
  const effortFor = subAgentEffortFor(deps.defaultEffort);
  const enabled = graph.subAgents.filter((s) => s.status === 'enabled');
  // #2050 / #1796 — a tool name two helpers (or a helper and another tool of
  // the agent) share is refused for ALL of them, never first-wins: which row
  // the database returned first must not decide which helper silently runs.
  const conflicts = new Map(
    helperToolNameConflicts(enabled, deps.reservedToolNames ?? new Set()).map((c) => [
      c.helperId,
      c,
    ]),
  );
  const parentHolds = deps.parentHolds ?? snapshotParentHolds(graph.toolGrants, deps);
  const runProvider = deps.hostIsCliProvider ? 'claude-cli' : deps.provider?.id;
  const defaultModel = helperDefaultModelRef(
    deps.defaultModel,
    deps.parentModelPolicy,
    runProvider,
  );
  for (const sub of enabled) {
    const conflict = conflicts.get(sub.id);
    if (conflict) {
      deps.log?.(
        `sub-agent tool: helper "${sub.name}" refused — its tool name "${conflict.toolName}" collides with ${
          conflict.withAgentTool ? 'another tool of this agent' : 'another helper of this agent'
        } (rename it in the Agent Builder)`,
      );
      continue;
    }
    const skill = sub.skillId ? skillsById.get(sub.skillId) : undefined;
    const modelVerdict = helperModelVerdict(sub.model, deps.parentModelPolicy, runProvider);
    if (!modelVerdict.allowed) {
      // #2050 — fail loud, never a silent drop: the helper stays a tool of
      // its agent and every call is refused with the reason, so the agent can
      // say why instead of acting as if it had no such helper. The Agent
      // Builder shows the same verdict on the helper (`helperOutOfService`).
      deps.log?.(`sub-agent tool: helper "${sub.name}" out of service — ${modelVerdict.reason}`);
      tools.push(outOfServiceHelperTool(sub, skill?.description, modelVerdict.reason));
      continue;
    }

    const skillBody = skill?.body;
    const basePrompt =
      sub.systemPromptOverride?.trim() ||
      skillBody?.trim() ||
      'Answer the delegated question precisely using your available tools.';
    // #2050 — appended whatever the skill or override says: the helper answers
    // its agent, never a person, and never presents itself by name.
    const systemPrompt = `${basePrompt}\n\n${INTERNAL_HELPER_CONTRACT}`;

    const subTools = resolveSubAgentTools(
      grantsBySubAgent.get(sub.id) ?? [],
      { ...deps, parentHolds },
    );

    // Resolve the picker-stored ref to the bare `modelId` — for the CLI branch
    // BEFORE the `-cli` strip, exactly like the orchestrator main model (issue
    // #296 BLOCKER). See `resolveCliSubAgentModel`.
    const subModel = deps.hostIsCliProvider
      ? (deps.cliModelAlias ?? ((model: string) => model))(
          resolveCliSubAgentModel(sub.model, defaultModel),
        )
      : resolveSubAgentModel(sub.model, { provider: deps.provider, defaultModel });
    // #1451 — both resolvers end in a raw tail, and the parent's default
    // (`SUBAGENT_DEFAULT_MODEL`) is itself a class ref: with a provider that
    // serves no model in the registry, `class:balanced` used to be handed to
    // `LocalSubAgent`, which sends it RAW — a vendor 404 on every delegated
    // turn. Skipped like an unresolvable tool grant below: the orchestrator
    // keeps working, this one delegation target is simply not offered.
    if (isClassRef(subModel)) {
      // #2050 — fail loud like a model the policy refuses: the helper's tool
      // stays and says why on every call, instead of vanishing.
      const reason = `its model '${sub.model?.trim() || defaultModel}' does not resolve for the provider '${deps.provider?.id ?? 'unknown'}'`;
      deps.log?.(`sub-agent tool: helper "${sub.name}" out of service — ${reason}`);
      tools.push(outOfServiceHelperTool(sub, skill?.description, reason));
      continue;
    }

    const agent: Askable = deps.hostIsCliProvider
      ? createCliSubAgent({
          name: sub.name,
          systemPrompt,
          model: subModel,
          tools: subTools,
          ...(deps.resolveCliBinary
            ? { resolveCliBinary: deps.resolveCliBinary }
            : {}),
        })
      : new LocalSubAgent({
          name: sub.name,
          provider: deps.provider,
          model: subModel,
          maxTokens: withinParent(sub.maxTokens ?? deps.defaultMaxTokens, deps.parentBudget?.maxTokens),
          maxIterations: withinParent(
            sub.maxIterations ?? deps.defaultMaxIterations,
            deps.parentBudget?.maxIterations,
          ),
          systemPrompt,
          tools: subTools,
          ...(effortFor !== undefined ? { effortFor } : {}),
        });

    tools.push({
      ...createDomainTool({
        name: subAgentToolName(sub.name),
        description: subAgentToolDescription(sub.name, skill?.description),
        agent,
        domain: `subagent.${slugifyDomain(sub.name)}`,
      }),
      internalHelper: { helperId: sub.id },
    });
  }
  return tools;
}

/**
 * #2050 — the tool of a helper whose model the agent's model policy does not
 * allow. Offered like the helper (same name and description), but every call
 * is refused with the reason, which reaches the agent's model unchanged
 * (`ToolRefusalError`), so a request for the helper ends in a clear message.
 */
function outOfServiceHelperTool(
  sub: { readonly id: string; readonly name: string },
  skillDescription: string | null | undefined,
  reason: string,
): DomainTool {
  const name = subAgentToolName(sub.name);
  return {
    ...createDomainTool({
      name,
      description: subAgentToolDescription(sub.name, skillDescription),
      agent: {
        ask: () =>
          Promise.reject(
            new ToolRefusalError(
              `The helper "${name}" is out of service: ${reason}. An operator has to change its model in the Agent Builder; nothing ran.`,
            ),
          ),
      },
      domain: `subagent.${slugifyDomain(sub.name)}`,
    }),
    internalHelper: { helperId: sub.id },
  };
}

/** A helper's own budget, capped by its parent's (#2050). */
function withinParent(own: number, parent: number | undefined): number {
  return parent !== undefined && parent > 0 ? Math.min(own, parent) : own;
}

/**
 * The default subset rule when the caller wires no live check: native grants
 * pass (the kernel checks plugin assignment), an MCP grant needs an agent-level
 * grant for the same server and tool in the snapshot.
 */
function snapshotParentHolds(
  grants: readonly ToolGrantRow[],
  deps: Pick<SubAgentToolDeps, 'mcpServersById'>,
): (grant: ToolGrantRow) => boolean {
  return (grant) =>
    grant.toolKind !== 'mcp' ||
    (grant.mcpServerId !== null &&
      mcpGrantHeldBy(
        grants,
        grant.mcpServerId,
        grant.toolRef,
        deps.mcpServersById?.get(grant.mcpServerId)?.name,
      ));
}

/**
 * #2050 — a helper's tool checks, on every call, that its agent still holds
 * the capability. A refused call throws a `ToolRefusalError`: the helper's
 * model reads why, and nothing ran.
 */
function guardedByParent(
  tool: LocalSubAgentTool,
  grant: ToolGrantRow,
  parentHolds: (grant: ToolGrantRow) => boolean,
  log: ((msg: string) => void) | undefined,
): LocalSubAgentTool {
  return {
    ...tool,
    handle: (input: unknown) => {
      if (!parentHolds(grant)) {
        log?.(
          `sub-agent tool: "${tool.spec.name}" refused at call time — the agent no longer holds this capability`,
        );
        return Promise.reject(
          new ToolRefusalError(
            `The tool "${tool.spec.name}" is not available: the agent this helper works for does not hold it.`,
          ),
        );
      }
      return tool.handle(input);
    },
  };
}

/**
 * Description of a sub-agent delegation tool.
 *
 * Doubles as routing text: the orchestrator renders its Fach-Werkzeuge roster as
 * one `- \`name\`: description` line per domain tool, so this string is what the
 * model picks a helper by. The helper's name alone carries no domain
 * information; its skill description does, when the skill has one.
 *
 * #2050 — a helper is the agent's internal helper, never a named specialist:
 * the description says so and tells the parent's model to present the result
 * as its own work, so "according to <helper>" never reaches a person. The name
 * is therefore not part of the text; the tool name is enough to call it.
 *
 * Stays on a single line for that reason, and states the delegation contract —
 * the sub-agent starts from an empty conversation and answers exactly once, so
 * a question that leans on context the parent has will come back wrong.
 *
 * The skill description is operator- or import-supplied text that lands in
 * the PARENT's system prompt and tool list, so it goes through
 * {@link skillDescriptionForRoster} first (#1219 review). The risk scan and
 * the skill's content hash cover it as well (`scanSkillForRisks`,
 * `computeSkillHash`).
 */
export function subAgentToolDescription(
  _name: string,
  skillDescription?: string | null,
): string {
  const scope = skillDescriptionForRoster(skillDescription);
  return [
    'Internal helper of this agent, not a colleague: hand it a focused part of your own work.',
    ...(scope ? [`Handles: ${scope}`] : []),
    'Its answer is your own work: use it in your reply without naming, quoting or' +
      ' crediting the helper.',
    'It sees none of this conversation and cannot ask follow-up questions, so' +
      ' send one self-contained question and expect a single answer back.',
  ].join(' ');
}

/** Upper bound for a skill description in the roster: a routing hint, not a
 *  second system prompt smuggled into the parent's. */
export const MAX_ROSTER_SKILL_DESCRIPTION_CHARS = 300;

/**
 * Control and invisible format characters (zero-width, bidi overrides, BOM),
 * plus the characters that could break the roster line's framing: backticks
 * (the tool name sits in a code span) and angle brackets (tag-shaped text).
 */
const UNSAFE_ROSTER_CHARS = /[\p{Cc}\p{Cf}`<>]/gu;

/**
 * A skill description as it may enter the parent's roster: unsafe characters
 * replaced, whitespace collapsed to one line, capped at
 * {@link MAX_ROSTER_SKILL_DESCRIPTION_CHARS} (cut at a word boundary, marked
 * with `…`) and ending in punctuation. Undefined when nothing is left.
 */
export function skillDescriptionForRoster(
  description?: string | null,
): string | undefined {
  if (typeof description !== 'string') return undefined;
  const plain = description
    .replace(UNSAFE_ROSTER_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length === 0) return undefined;
  if (plain.length > MAX_ROSTER_SKILL_DESCRIPTION_CHARS) {
    const cut = plain.slice(0, MAX_ROSTER_SKILL_DESCRIPTION_CHARS - 1);
    const atWord = cut.replace(/\s+\S*$/, '');
    return `${(atWord.length > 0 ? atWord : cut).trimEnd()}…`;
  }
  return /[.!?]$/.test(plain) ? plain : `${plain}.`;
}

/**
 * Resolve a sub-agent's persisted `model` ref to the active provider's concrete
 * bare `modelId` (issue #296 MAJOR 3). `LocalSubAgent` sends `model` RAW to the
 * provider adapter, exactly like the orchestrator main loop — so a picker-stored
 * provider-qualified id (`anthropic:claude-opus-4-8`) or alias (`opus`) would
 * 404 every delegated turn. Shares the resolver with the orchestrator path
 * (`resolveModelIdForProvider`); an empty / unknown / cross-provider ref
 * degrades to the parent's default model instead of 404ing. The CLI sub-agent
 * path keeps its own alias scheme (`cliModelAlias`) and is not routed here.
 */
export function resolveSubAgentModel(
  ref: string | null | undefined,
  deps: Pick<SubAgentToolDeps, 'provider' | 'defaultModel'>,
): string {
  const providerId = deps.provider?.id;
  const picked = resolveConfiguredModel(ref, providerId);
  if (picked !== undefined) return picked;
  // The parent's default is itself a ref (a class ref since the catalog went
  // live-discovered) — resolve it the same way; a raw class ref must never
  // reach the wire.
  //
  // #1451 — the tail can still hand back a class ref when the provider serves
  // NO model in the registry (reachable: an operator-typed, registry-unknown
  // `orchestrator_model` activates fine in that state). The caller
  // (`buildSubAgentDomainTools`) therefore skips a sub-agent whose resolved
  // model is still a class ref rather than letting it reach the wire.
  return resolveConfiguredModel(deps.defaultModel, providerId) ?? deps.defaultModel;
}

/**
 * CLI-provider variant of `resolveSubAgentModel` (issue #296 BLOCKER). The CLI
 * sub-agent runs the picked ref through `cliModelAlias` (which strips the `-cli`
 * suffix back to `opus`/`sonnet`/`haiku`), so the ref must first be resolved to
 * the bare CLI `modelId` — a picker-stored `claude-cli:opus-cli` must become
 * `opus-cli` (→ `opus`), NOT reach the strip raw (→ the invalid `claude-cli:opus`).
 *
 * Resolves against `claude-cli` explicitly (the caller is inside the
 * `hostIsCliProvider` branch and `deps.provider` may be absent on the hydrate
 * path). A ref that does not resolve under `claude-cli` — a legacy bare alias
 * (`opus`) or full vendor id — falls through untouched so `cliModelAlias`
 * handles it exactly as before; an empty ref inherits the parent default.
 * Mirrors the orchestrator main model's overlay resolution in `applyDiff`.
 */
export function resolveCliSubAgentModel(
  ref: string | null | undefined,
  defaultModel: string,
): string {
  return (
    (resolveModelIdForProvider(ref, 'claude-cli') ?? ref?.trim()) ||
    defaultModel
  );
}

/**
 * Exported for the W0-3 determinism test; production callers should go
 * through `buildSubAgentDomainTools`.
 */
export function resolveSubAgentTools(
  grants: readonly ToolGrantRow[],
  deps: SubAgentToolDeps,
): LocalSubAgentTool[] {
  const out: LocalSubAgentTool[] = [];
  const parentHolds = deps.parentHolds;
  const guard = (t: LocalSubAgentTool, g: ToolGrantRow): LocalSubAgentTool =>
    parentHolds ? guardedByParent(t, g, parentHolds, deps.log) : t;
  for (const g of grants) {
    // #2050 — a grant the parent agent does not hold is never materialised.
    if (parentHolds && !parentHolds(g)) {
      deps.log?.(
        `sub-agent tool: ${g.toolKind} grant "${g.toolRef}" refused — the agent itself does not hold it`,
      );
      continue;
    }
    if (g.toolKind === 'native') {
      const t = deps.nativeTool?.(g.toolRef);
      if (t) out.push(guard(t, g));
      else deps.log?.(`sub-agent tool: native tool "${g.toolRef}" not resolvable — skipped`);
      continue;
    }
    // mcp
    if (!g.mcpServerId || !deps.mcpManager || !deps.mcpServersById) {
      deps.log?.(`sub-agent tool: mcp grant "${g.toolRef}" missing manager/server — skipped`);
      continue;
    }
    const cfg = deps.mcpServersById.get(g.mcpServerId);
    if (!cfg) {
      deps.log?.(`sub-agent tool: mcp server ${g.mcpServerId} not found — skipped`);
      continue;
    }
    const toolName = mcpToolNameFromRef(g.toolRef, cfg.name);
    if (deps.blockedMcpGrant?.(g.mcpServerId, toolName)) {
      deps.log?.(
        `sub-agent tool: mcp tool "${toolName}" on "${cfg.name}" blocked by scan-verdict policy — skipped`,
      );
      continue;
    }
    out.push(
      guard(mcpToolToLocalSubAgentTool(deps.mcpManager, cfg, { name: toolName }), g),
    );
  }
  // W0-3 — sort by name. Grants arrive in `created_at` row order, so two
  // machines that were seeded at different times would hand the sub-agent an
  // identical tool SET in a different sequence, defeating prompt caching on
  // the sub-agent's own tool block for no behavioural gain.
  return sortBySpecName(out);
}

/** `toolRef` for an mcp grant is "<serverName>:<toolName>"; fall back to the
 *  whole ref when it isn't prefixed. */
export function mcpToolNameFromRef(toolRef: string, serverName: string): string {
  const prefix = `${serverName}:`;
  if (toolRef.startsWith(prefix)) return toolRef.slice(prefix.length);
  const idx = toolRef.indexOf(':');
  return idx >= 0 ? toolRef.slice(idx + 1) : toolRef;
}

/** `ask_<slug>` constrained to Anthropic's tool-name charset (`[a-zA-Z0-9_-]{1,64}`).
 *  Not injective (`A B` and `A-B` both map to `ask_a_b`): uniqueness is
 *  enforced by `helperToolNameConflicts` / `assertHelperNameFree` (#2050). */
export function subAgentToolName(name: string): string {
  return helperToolName(name);
}

/** Lowercase dotted-domain segment (matches PLUGIN_DOMAIN_REGEX once prefixed). */
function slugifyDomain(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (s.length === 0) s = 'agent';
  if (!/^[a-z]/.test(s)) s = `a${s}`;
  return s;
}
