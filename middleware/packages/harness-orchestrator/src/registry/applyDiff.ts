import {
  buildOrchestratorForAgent,
  type AgentRuntimeConfig,
  type BuiltOrchestrator,
  type OrchestratorDeps,
} from '../buildOrchestrator.js';

import type {
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from './agentGraphStore.js';
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  resolveAgentModelRouting,
  resolveModelIdForProvider,
} from './agentRuntime.js';
import type {
  AgentPluginRow,
  AgentRow,
  ChannelBindingRow,
  ConfigSnapshot,
} from './configStore.js';

/**
 * `applyDiff` (US5 / T020).
 *
 * Diff oldSnap vs newSnap and produce the minimal set of actions needed to
 * bring the live registry from old → new. Each action is structurally
 * isolated (T022): a throwing build or close affects only the failing
 * Agent, never the rest of the diff.
 *
 * Action types:
 *
 *  - `add`     — Agent appeared (new row OR status flipped disabled → enabled).
 *                Build a fresh `BuiltOrchestrator`.
 *  - `remove`  — Agent disappeared (row deleted OR status flipped to
 *                disabled). Drop the existing `BuiltOrchestrator`.
 *  - `rebuild` — Agent kept its slug but a runtime-relevant field changed
 *                (privacy_profile, runtime config). Tear down + rebuild.
 *  - `update`  — Agent kept its slug AND its runtime config; only the
 *                plugin / binding lists changed. Refresh registry metadata
 *                without touching the `Orchestrator` instance — sessions
 *                in-flight on the old plugin set keep working (US6).
 *
 * The function does NOT touch the registry itself; it returns a typed plan
 * the caller (OrchestratorRegistry) executes. This keeps `applyDiff` pure
 * and unit-testable in isolation.
 */

export type DiffAction =
  | { readonly kind: 'add'; readonly agent: AgentRow }
  | { readonly kind: 'remove'; readonly slug: string }
  | { readonly kind: 'rebuild'; readonly agent: AgentRow; readonly reason: string }
  | { readonly kind: 'update'; readonly agent: AgentRow };

export interface DiffPlan {
  readonly actions: readonly DiffAction[];
  /** True iff the platform-wide settings (e.g. fallback_agent_id) changed. */
  readonly platformChanged: boolean;
}

export function diffSnapshots(
  oldSnap: ConfigSnapshot | undefined,
  newSnap: ConfigSnapshot,
): DiffPlan {
  const actions: DiffAction[] = [];

  const oldBySlug = new Map<string, AgentRow>(
    (oldSnap?.agents ?? []).map((a) => [a.slug, a]),
  );
  const newBySlug = new Map<string, AgentRow>(
    newSnap.agents.map((a) => [a.slug, a]),
  );

  const oldPluginsByAgent = groupBy(
    (oldSnap?.agentPlugins ?? []).filter((p) => p.enabled),
    (p) => p.agentId,
  );
  const newPluginsByAgent = groupBy(
    newSnap.agentPlugins.filter((p) => p.enabled),
    (p) => p.agentId,
  );

  const oldBindingsByAgent = groupBy(
    oldSnap?.channelBindings ?? [],
    (b) => b.agentId,
  );
  const newBindingsByAgent = groupBy(
    newSnap.channelBindings,
    (b) => b.agentId,
  );

  for (const [slug, newAgent] of newBySlug) {
    const oldAgent = oldBySlug.get(slug);

    // Treat `disabled` as absent from the registry.
    const wasEnabled = !!oldAgent && oldAgent.status === 'enabled';
    const isEnabled = newAgent.status === 'enabled';

    if (!wasEnabled && isEnabled) {
      actions.push({ kind: 'add', agent: newAgent });
      continue;
    }
    if (wasEnabled && !isEnabled) {
      actions.push({ kind: 'remove', slug });
      continue;
    }
    if (!isEnabled) continue;

    // Both old and new are enabled. Decide rebuild vs metadata-only update.
    const reasons = [
      ...runtimeChangeReasons(oldAgent!, newAgent),
      ...graphChangeReasons(oldAgent!.id, newAgent.id, oldSnap, newSnap),
    ];
    if (reasons.length > 0) {
      actions.push({
        kind: 'rebuild',
        agent: newAgent,
        reason: reasons.join('+'),
      });
      continue;
    }

    const oldPlugins = oldPluginsByAgent.get(oldAgent!.id) ?? [];
    const newPlugins = newPluginsByAgent.get(newAgent.id) ?? [];
    const oldBindings = oldBindingsByAgent.get(oldAgent!.id) ?? [];
    const newBindings = newBindingsByAgent.get(newAgent.id) ?? [];

    if (
      !equalPlugins(oldPlugins, newPlugins) ||
      !equalBindings(oldBindings, newBindings)
    ) {
      actions.push({ kind: 'update', agent: newAgent });
    }
  }

  for (const [slug, oldAgent] of oldBySlug) {
    if (newBySlug.has(slug)) continue;
    if (oldAgent.status !== 'enabled') continue;
    actions.push({ kind: 'remove', slug });
  }

  const platformChanged =
    !oldSnap ||
    oldSnap.platformSettings.fallbackAgentId !==
      newSnap.platformSettings.fallbackAgentId;

  return { actions, platformChanged };
}

/**
 * Execute a single `add` / `rebuild` action: build a fresh
 * `BuiltOrchestrator` for the Agent. Wrapped by the caller in a try/catch
 * so a throw is isolated to this Agent (T022). Pure factory — no registry
 * mutation.
 */
export function buildForAgent(
  agent: AgentRow,
  deps: OrchestratorDeps,
  runtime: Omit<AgentRuntimeConfig, 'agentId'>,
): BuiltOrchestrator {
  // Agent Builder P5 — overlay the agent's persisted model_routing onto the
  // platform default: `main` overrides the model, `triage` mode adds per-turn
  // Haiku→Sonnet/Opus routing. Falls back to the platform runtime when unset.
  const routing = resolveAgentModelRouting(agent.modelRouting);

  // The orchestrator hands `model` to a SINGLE concrete provider adapter, which
  // sends it RAW to the wire API (no ref→modelId resolution in the send path).
  // The Admin picker stores a provider-qualified id / alias, so resolve the
  // per-Agent overlay to the active provider's concrete `modelId` HERE — see
  // `resolveModelIdForProvider` (issue #296).
  //
  // The CLI provider is resolved like any other — its models ARE registered
  // (`claude-cli:opus-cli` etc.), so `resolveModelIdForProvider('claude-cli:opus-cli',
  // 'claude-cli')` → `opus-cli` → (`-cli` stripped downstream) → `opus`, the
  // alias the CLI expects. The old code special-cased CLI to pass the ref RAW,
  // which left the picker's `claude-cli:opus-cli` unresolved → `claude-cli:opus`
  // after the strip → an invalid `--model` on every turn (issue #296 BLOCKER).
  //
  // A ref the resolver returns `undefined` for (a registry-known CROSS-provider
  // id, or a legacy bare CLI alias like `opus`) falls through to the raw trimmed
  // ref. Cross-provider picks are rejected at WRITE time (the model-routing /
  // sub-agent validators are scoped to the active provider, issue #296 MAJOR),
  // so a cross-provider ref never reaches here for a fresh write; the raw
  // fallthrough is what lets a CLI deployment's bare alias (`opus`) run. A
  // registry-UNKNOWN same-context ref is already returned raw by the resolver.
  // The platform default (`runtime.model`, operator-set env) is not passed
  // through here — it works raw today and resolving it would change established
  // behaviour.
  const activeProvider = deps.provider?.id;
  const resolveOverlay = (ref: string | undefined): string | undefined =>
    (resolveModelIdForProvider(ref, activeProvider) ?? ref?.trim()) || undefined;

  // Per-instance model resolution (issue #296 AC#2), three tiers:
  //   1. the Agent's `model_routing.main` (operator's per-Agent choice)
  //   2. the global seeded platform default `runtime.model`
  //      (= `orchestrator_model` install config = `ORCHESTRATOR_MODEL` env)
  //   3. `DEFAULT_ORCHESTRATOR_MODEL` — guards against an empty / whitespace
  //      platform default so the turn loop never gets an empty model id.
  const model =
    resolveOverlay(routing.model) ||
    runtime.model?.trim() ||
    DEFAULT_ORCHESTRATOR_MODEL;

  // Resolve the per-turn routing sub-models the same way. Any sub-model that
  // does not resolve to the active provider falls back to the resolved `model`
  // so every id the turn loop sends is a valid same-provider `modelId`.
  const overlayRouting = routing.modelRouting
    ? {
        classifierModel:
          resolveOverlay(routing.modelRouting.classifierModel) ?? model,
        simpleModel: resolveOverlay(routing.modelRouting.simpleModel) ?? model,
        complexModel: resolveOverlay(routing.modelRouting.complexModel) ?? model,
      }
    : undefined;

  return buildOrchestratorForAgent(
    {
      agentId: agent.slug,
      model,
      maxTokens: runtime.maxTokens,
      maxToolIterations: runtime.maxToolIterations,
      // Per-turn model routing: prefer the agent's own persisted routing
      // (Agent Builder P5); otherwise fall back to the platform default
      // `runtime.modelRouting` so registry-managed orchestrators still emit
      // `turn_routing` and the UI renders the Haiku-triage badge (origin/main).
      ...((overlayRouting ?? runtime.modelRouting)
        ? { modelRouting: overlayRouting ?? runtime.modelRouting }
        : {}),
      ...(runtime.loopRepeatSoft !== undefined
        ? { loopRepeatSoft: runtime.loopRepeatSoft }
        : {}),
      ...(runtime.loopRepeatHard !== undefined
        ? { loopRepeatHard: runtime.loopRepeatHard }
        : {}),
      ...(runtime.maxTurnSeconds !== undefined
        ? { maxTurnSeconds: runtime.maxTurnSeconds }
        : {}),
    },
    deps,
  );
}

function runtimeChangeReasons(oldAgent: AgentRow, newAgent: AgentRow): string[] {
  const reasons: string[] = [];
  if (oldAgent.privacyProfile !== newAgent.privacyProfile) {
    reasons.push(
      `privacy_profile:${oldAgent.privacyProfile}->${newAgent.privacyProfile}`,
    );
  }
  // Per-agent model routing (Agent Builder P5) changes which model the turn
  // loop selects — a runtime-relevant change warranting a rebuild.
  if (
    JSON.stringify(oldAgent.modelRouting ?? null) !==
    JSON.stringify(newAgent.modelRouting ?? null)
  ) {
    reasons.push('model_routing');
  }
  // `name` / `description` are display-only and never warrant a rebuild —
  // they would invalidate sessions for no semantic gain.
  return reasons;
}

/**
 * Agent Builder graph (P0): rebuild when an agent's sub-agents, tool grants,
 * or any skill referenced by those sub-agents changed. These define what the
 * orchestrator (and its LocalSubAgents) can do, so a change is runtime-
 * relevant. Schedules are intentionally excluded — they are consumed by the
 * cron worker, not baked into the orchestrator build.
 */
function graphChangeReasons(
  oldAgentId: string,
  newAgentId: string,
  oldSnap: ConfigSnapshot | undefined,
  newSnap: ConfigSnapshot,
): string[] {
  const oldSig = graphSignature(oldAgentId, oldSnap);
  const newSig = graphSignature(newAgentId, newSnap);
  return oldSig === newSig ? [] : ['graph'];
}

/**
 * Deterministic fingerprint of an agent's graph wiring within one snapshot:
 * its sub-agents, the tool grants targeting the agent or those sub-agents,
 * and the bodies of any skills those sub-agents reference. Order-independent
 * (everything is sorted) so it captures semantic, not row-order, change.
 */
function graphSignature(
  agentId: string,
  snap: ConfigSnapshot | undefined,
): string {
  const subAgents: readonly SubAgentRow[] = (snap?.subAgents ?? []).filter(
    (s) => s.parentAgentId === agentId,
  );
  const subAgentIds = new Set(subAgents.map((s) => s.id));
  const skillIds = new Set(
    subAgents.map((s) => s.skillId).filter((id): id is string => !!id),
  );

  const grants: readonly ToolGrantRow[] = (snap?.toolGrants ?? []).filter(
    (g) =>
      (g.agentId !== null && g.agentId === agentId) ||
      (g.subAgentId !== null && subAgentIds.has(g.subAgentId)),
  );

  const skills: readonly SkillRow[] = (snap?.skills ?? []).filter((sk) =>
    skillIds.has(sk.id),
  );

  const subPart = subAgents
    .map(
      (s) =>
        `${s.id}|${s.name}|${s.skillId ?? ''}|${s.model ?? ''}|${
          s.maxTokens ?? ''
        }|${s.maxIterations ?? ''}|${s.systemPromptOverride ?? ''}|${s.status}`,
    )
    .sort();
  const grantPart = grants
    .map(
      (g) =>
        `${g.agentId ?? ''}|${g.subAgentId ?? ''}|${g.toolKind}|${g.toolRef}|${
          g.mcpServerId ?? ''
        }|${JSON.stringify(g.config)}`,
    )
    .sort();
  const skillPart = skills
    .map(
      (sk) => `${sk.id}|${sk.name}|${sk.body}|${JSON.stringify(sk.frontmatter)}`,
    )
    .sort();

  return JSON.stringify({ subPart, grantPart, skillPart });
}

function equalPlugins(
  a: readonly AgentPluginRow[],
  b: readonly AgentPluginRow[],
): boolean {
  if (a.length !== b.length) return false;
  const aKey = a
    .map((p) => `${p.pluginId}:${JSON.stringify(p.config)}`)
    .sort();
  const bKey = b
    .map((p) => `${p.pluginId}:${JSON.stringify(p.config)}`)
    .sort();
  return aKey.every((k, i) => k === bKey[i]);
}

function equalBindings(
  a: readonly ChannelBindingRow[],
  b: readonly ChannelBindingRow[],
): boolean {
  if (a.length !== b.length) return false;
  const aKey = a.map((bnd) => `${bnd.channelType}|${bnd.channelKey}`).sort();
  const bKey = b.map((bnd) => `${bnd.channelType}|${bnd.channelKey}`).sort();
  return aKey.every((k, i) => k === bKey[i]);
}

function groupBy<T, K>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}
