/**
 * Plugin self-extension — permission surface extraction + subset check.
 *
 * The security spine of operator-gated self-extension. A plugin may rewrite its
 * own spec (add tools, slots, prose) but it must NEVER grant itself a right it
 * does not already hold — "kein schreibender Zugriff, außer das Plugin hat ihn
 * bereits" (no write access unless already held). To enforce that mechanically
 * we reduce an {@link AgentSpec} to its *privilege surface*: the finite set of
 * rights the kernel actually hands out at runtime, derived from the manifest:
 *
 *   - `depends_on`            → Vault scope + parent-integration inheritance
 *   - `permissions.graph.*`   → knowledge-graph reads / writes / entity-systems
 *   - `permissions.subAgents` → which agents it may delegate to
 *   - `permissions.llm`       → which models it may call
 *   - `network.outbound`      → egress allow-list (+ `web_scanner` widening)
 *   - `external_reads`        → cross-integration data pulls (service.method)
 *   - `privacy_class`         → strict ⇒ data-plane internment guardrail
 *
 * The escalation guard ({@link ./escalationGuard.ts}) compares the proposed
 * surface against the current one: any dimension that *widens* is an
 * escalation, auto-denied before it ever reaches the operator. Comparison is
 * wildcard-aware (an existing `claude-haiku-4-5*` covers a proposed
 * `claude-haiku-4-5-x`) and fail-safe: when coverage cannot be PROVEN, the item
 * counts as an escalation.
 */

import type { Plugin } from '../../api/admin-v1.js';
import type { AgentSpec } from '../builder/agentSpec.js';

export type PrivacyClass = 'strict' | 'default';

/**
 * Normalised privilege surface of a spec. Every set holds the raw manifest
 * strings (globs/wildcards preserved) so the subset check can reason about
 * coverage rather than identity.
 */
export interface PermissionSurface {
  readonly dependsOn: ReadonlySet<string>;
  readonly graphReads: ReadonlySet<string>;
  readonly graphWrites: ReadonlySet<string>;
  readonly graphEntitySystems: ReadonlySet<string>;
  readonly subAgentCalls: ReadonlySet<string>;
  readonly llmModels: ReadonlySet<string>;
  readonly networkOutbound: ReadonlySet<string>;
  readonly webScanner: boolean;
  /** `service::model::method` triples — model defaults to `*` when omitted. */
  readonly externalReads: ReadonlySet<string>;
  readonly privacyClass: PrivacyClass;
}

/** The dimensions the escalation guard reports on. */
export type SurfaceDimension =
  | 'depends_on'
  | 'graph.reads'
  | 'graph.writes'
  | 'graph.entity_systems'
  | 'subAgents.calls'
  | 'llm.models_allowed'
  | 'network.outbound'
  | 'network.web_scanner'
  | 'external_reads'
  | 'privacy_class';

export interface SurfaceWidening {
  readonly dimension: SurfaceDimension;
  /** The specific item (or sentinel) that widened the surface. */
  readonly item: string;
  readonly reason: string;
}

function externalReadKey(read: AgentSpec['external_reads'][number]): string {
  return `${read.service}::${read.model ?? '*'}::${read.method}`;
}

/** Reduce a spec to its privilege surface. Pure. */
export function extractPermissionSurface(spec: AgentSpec): PermissionSurface {
  const graph = spec.permissions?.graph;
  return {
    dependsOn: new Set(spec.depends_on),
    graphReads: new Set(graph?.reads ?? []),
    graphWrites: new Set(graph?.writes ?? []),
    graphEntitySystems: new Set(graph?.entity_systems ?? []),
    subAgentCalls: new Set(spec.permissions?.subAgents?.calls ?? []),
    llmModels: new Set(spec.permissions?.llm?.models_allowed ?? []),
    networkOutbound: new Set(spec.network?.outbound ?? []),
    webScanner: spec.network?.web_scanner === true,
    externalReads: new Set(spec.external_reads.map(externalReadKey)),
    privacyClass: spec.privacy_class,
  };
}

/**
 * Reduce an INSTALLED plugin's manifest to the same privilege surface. This is
 * the universal path used for plugins that have no Builder `AgentSpec` draft —
 * hand-written / side-loaded packages (e.g. the Dynamics CRM plugin). It maps
 * the loader-assembled {@link PluginPermissionsSummary} onto the identical
 * dimensions as {@link extractPermissionSurface}, so the escalation guard runs
 * unchanged against either source.
 *
 * `externalReads` has no manifest equivalent (a standalone plugin's egress
 * lives in `network_outbound`), and `memory_*` is intentionally NOT a surface
 * dimension on either side — it mirrors the spec's `PermissionsSchema`
 * (graph / subAgents / llm / network), so a template may not request memory
 * scopes in v1.
 */
export function extractSurfaceFromManifest(plugin: Plugin): PermissionSurface {
  const p = plugin.permissions_summary;
  return {
    dependsOn: new Set<string>(plugin.depends_on),
    graphReads: new Set<string>(p.graph_reads),
    graphWrites: new Set<string>(p.graph_writes),
    graphEntitySystems: new Set(p.graph_entity_systems ?? []),
    subAgentCalls: new Set(p.sub_agents_calls ?? []),
    llmModels: new Set(p.llm_models_allowed ?? []),
    networkOutbound: new Set(p.network_outbound),
    webScanner: p.network_web_scanner === true,
    externalReads: new Set<string>(),
    privacyClass: plugin.privacy_class,
  };
}

/**
 * Build a {@link PermissionSurface} from a sparse descriptor — used to express
 * what an {@link ExtensionTemplate} *requires*, so the guard can prove
 * `requires ⊆ manifestSurface` via {@link computeWidenings}. Omitted dimensions
 * default to empty / least-privilege (`webScanner:false`, `privacyClass:'strict'`).
 */
export interface PartialSurface {
  dependsOn?: readonly string[];
  graphReads?: readonly string[];
  graphWrites?: readonly string[];
  graphEntitySystems?: readonly string[];
  subAgentCalls?: readonly string[];
  llmModels?: readonly string[];
  networkOutbound?: readonly string[];
  webScanner?: boolean;
  externalReads?: readonly string[];
  privacyClass?: PrivacyClass;
}

export function surfaceFromPartial(partial: PartialSurface): PermissionSurface {
  return {
    dependsOn: new Set(partial.dependsOn ?? []),
    graphReads: new Set(partial.graphReads ?? []),
    graphWrites: new Set(partial.graphWrites ?? []),
    graphEntitySystems: new Set(partial.graphEntitySystems ?? []),
    subAgentCalls: new Set(partial.subAgentCalls ?? []),
    llmModels: new Set(partial.llmModels ?? []),
    networkOutbound: new Set(partial.networkOutbound ?? []),
    webScanner: partial.webScanner === true,
    externalReads: new Set(partial.externalReads ?? []),
    privacyClass: partial.privacyClass ?? 'strict',
  };
}

/**
 * Does `pattern` cover `item`? Exact match, `*` wildcard, or a trailing-`*`
 * prefix glob (`agent:x:*` covers `agent:x:notes`; `claude-haiku-4-5*` covers
 * `claude-haiku-4-5-1`). Anything else is NOT covered — deliberately
 * conservative so a broader proposed glob never slips past a narrower grant.
 */
export function patternCovers(pattern: string, item: string): boolean {
  if (pattern === item) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return item.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/** True iff at least one `pattern` in `patterns` covers `item`. */
export function coveredByAny(
  item: string,
  patterns: Iterable<string>,
): boolean {
  for (const pattern of patterns) {
    if (patternCovers(pattern, item)) return true;
  }
  return false;
}

interface SetDimension {
  dimension: SurfaceDimension;
  current: ReadonlySet<string>;
  proposed: ReadonlySet<string>;
}

/**
 * Compute every way `proposed` widens the privilege surface beyond `current`.
 * Empty result ⇒ `proposed ⊆ current` ⇒ no escalation. The list is the exact,
 * operator-facing justification for an auto-denial.
 */
export function computeWidenings(
  current: PermissionSurface,
  proposed: PermissionSurface,
): SurfaceWidening[] {
  const widenings: SurfaceWidening[] = [];

  const setDims: SetDimension[] = [
    { dimension: 'depends_on', current: current.dependsOn, proposed: proposed.dependsOn },
    { dimension: 'graph.reads', current: current.graphReads, proposed: proposed.graphReads },
    { dimension: 'graph.writes', current: current.graphWrites, proposed: proposed.graphWrites },
    {
      dimension: 'graph.entity_systems',
      current: current.graphEntitySystems,
      proposed: proposed.graphEntitySystems,
    },
    { dimension: 'subAgents.calls', current: current.subAgentCalls, proposed: proposed.subAgentCalls },
    { dimension: 'llm.models_allowed', current: current.llmModels, proposed: proposed.llmModels },
    { dimension: 'network.outbound', current: current.networkOutbound, proposed: proposed.networkOutbound },
    { dimension: 'external_reads', current: current.externalReads, proposed: proposed.externalReads },
  ];

  for (const { dimension, current: cur, proposed: prop } of setDims) {
    for (const item of prop) {
      if (!coveredByAny(item, cur)) {
        widenings.push({
          dimension,
          item,
          reason: `'${item}' is not covered by any current ${dimension} grant`,
        });
      }
    }
  }

  // web_scanner: false → true widens the egress filter (guardrail relaxation).
  if (proposed.webScanner && !current.webScanner) {
    widenings.push({
      dimension: 'network.web_scanner',
      item: 'web_scanner',
      reason: 'enabling network.web_scanner widens the egress allow-list',
    });
  }

  // privacy_class: strict → default loosens the data-plane internment
  // guardrail. The reverse (default → strict) tightens it and is allowed.
  if (current.privacyClass === 'strict' && proposed.privacyClass === 'default') {
    widenings.push({
      dimension: 'privacy_class',
      item: 'strict→default',
      reason: 'loosening privacy_class from strict to default relaxes the data-plane guardrail',
    });
  }

  return widenings;
}

/** Convenience predicate: `proposed ⊆ current` for every dimension. */
export function isSurfaceSubset(
  current: PermissionSurface,
  proposed: PermissionSurface,
): boolean {
  return computeWidenings(current, proposed).length === 0;
}
