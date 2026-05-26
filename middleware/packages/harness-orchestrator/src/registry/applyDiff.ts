import {
  buildOrchestratorForAgent,
  type AgentRuntimeConfig,
  type BuiltOrchestrator,
  type OrchestratorDeps,
} from '../buildOrchestrator.js';

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
    const reasons = runtimeChangeReasons(oldAgent!, newAgent);
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
  return buildOrchestratorForAgent(
    {
      agentId: agent.slug,
      model: runtime.model,
      maxTokens: runtime.maxTokens,
      maxToolIterations: runtime.maxToolIterations,
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
  // `name` / `description` are display-only and never warrant a rebuild —
  // they would invalidate sessions for no semantic gain.
  return reasons;
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
