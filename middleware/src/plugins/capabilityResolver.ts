import {
  parseCapabilityRef,
  type CapabilityRef,
} from '@omadia/plugin-api';

import type {
  Plugin,
  PluginInstallState,
  PluginKind,
} from '../api/admin-v1.js';
import type { InstalledRegistry } from './installedRegistry.js';
import type { PluginCatalog, PluginCatalogEntry } from './manifestLoader.js';

/**
 * Manifest-level capability resolution — runs before `topoSortByDependsOn`
 * picks the activation order. Two layers, two failure modes:
 *
 *   1. {@link resolveCapabilities} — single-pass over the eligible set.
 *      Returns `{ edges, unresolved, duplicateProviders }` instead of
 *      throwing on a missing provider; the caller decides whether boot-time soft-fail
 *      (mark errored, keep middleware up) or install-time hard-block
 *      (HTTP 409, surface available providers from the wider catalog) is
 *      the right response. OM-87 / #1053 keeps provider collisions strict
 *      by default; boot opts into reporting the younger provider instead.
 *
 *   2. {@link resolveEligiblePlugins} — iterative wrapper around (1) used
 *      by the runtime. Drops duplicate providers and unresolved consumers,
 *      re-runs the single-pass until the eligible set stabilises. This
 *      handles the cascade where consumer A requires cap X provided only
 *      by plugin B, B itself unresolved → A also unresolvable.
 *
 *   3. {@link walkCapabilityInstallChain} — transitive catalog walk for
 *      the install-time gate. Given a target plugin not yet installed,
 *      enumerates every requires-chain capability that lacks an active
 *      provider in `installedRegistry`, paired with the catalog plugins
 *      that *could* provide it. The HTTP layer surfaces this as
 *      `details.available_providers` so the operator-side wizard can
 *      issue a chained install in topo-order. Server-side and complete
 *      (catalog-walk lives here, not in the frontend).
 *
 * `MissingCapabilityError` stays exported for install-time callers that
 * still want a typed throw — the resolver itself no longer raises it.
 */

export class MissingCapabilityError extends Error {
  public readonly consumerId: string;
  public readonly capability: string;
  constructor(consumerId: string, capability: string) {
    super(
      `plugin '${consumerId}' requires capability '${capability}' but no installed plugin provides it`,
    );
    this.name = 'MissingCapabilityError';
    this.consumerId = consumerId;
    this.capability = capability;
  }
}

export interface CapabilityEdge {
  /** Plugin id that provides — activates first. */
  from: string;
  /** Plugin id that requires — activates after `from`. */
  to: string;
}

export interface UnresolvedRequire {
  /** Plugin id whose `requires` list could not be fully resolved. */
  consumerId: string;
  /** Raw `<name>@<major>` strings (the manifest entries) that lack a
   *  provider in the eligible set. */
  requires: string[];
}

export interface DuplicateProvider {
  readonly droppedId: string;
  /** OM-87: winner of this collision, not a promise of activation. It may
   *  later lose a different slot or fail its own requires; the diagnostic
   *  still names the installed manifest that caused this exclusion. */
  readonly keptId: string;
  /** Raw manifest `provides` entry at the collision, for the operator. */
  readonly capability: string;
  readonly message: string;
}

export interface CapabilityResolutionOptions {
  readonly onDuplicate?: 'throw' | 'errored';
  /** OM-87 keeps the pure resolver independent of registry storage. The
   *  boot caller supplies the timestamps it already reads for eligibility;
   *  callers without registry state retain deterministic input-order ties. */
  readonly installedAtById?: ReadonlyMap<string, string>;
}

export interface CapabilityResolution {
  /** Implicit provider→consumer ordering edges, suitable for passing to
   *  {@link topoSortByDependsOn} as `extraEdges`. */
  edges: CapabilityEdge[];
  /** Consumers whose `requires` list is not fully covered by the
   *  eligible set. The caller decides what to do (mark errored, throw,
   *  drop and retry). */
  unresolved: UnresolvedRequire[];
  /** OM-87: provided capabilities must never enter `unresolved.requires`,
   *  which bootstrap persists as a re-checkable dependency list (S+8.5). */
  duplicateProviders: DuplicateProvider[];
}

/**
 * Single-pass resolver. Walks every eligible plugin's `requires`,
 * matches against the rest's `provides`, and aggregates unresolved
 * entries instead of throwing.
 *
 * OM-87 / #1053 leaves the single-pass default at `throw`: existing strict
 * callers keep their contract without call-site churn. The boot wrapper
 * defaults to `errored`, retaining the older provider and reporting the
 * younger one separately from missing dependencies.
 */
export function resolveCapabilities(
  eligibleIds: readonly string[],
  catalog: PluginCatalog,
  options: CapabilityResolutionOptions = {},
): CapabilityResolution {
  const edges: CapabilityEdge[] = [];
  const unresolved: UnresolvedRequire[] = [];
  const { index: providerIndex, duplicateProviders } = buildProviderIndex(
    eligibleIds,
    catalog,
    options,
  );
  const dropped = new Set(duplicateProviders.map((d) => d.droppedId));

  for (const consumerId of eligibleIds) {
    // OM-87: a duplicate is excluded as a whole plugin, including its
    // requires. Reporting it twice would corrupt the dependency retry path.
    if (dropped.has(consumerId)) continue;
    const consumer = catalog.get(consumerId);
    // `requires` ONLY. `optional_requires` (#795) is deliberately not read
    // here, and the omission is the whole feature: an optional capability
    // must neither hold a consumer back nor contribute an ordering edge.
    //
    // Skipping the edge is the part worth arguing about, because an
    // optional provider that IS installed may then activate after its
    // consumer. That is accepted knowingly: optional dependencies are the
    // shape most likely to point back at the plugin that offers them
    // (A optionally uses B, B requires A), and an edge from a link the
    // kernel is not allowed to enforce would turn that into a topo-sort
    // cycle — a boot failure caused by a dependency declared as skippable.
    // The cost lands in the API contract instead, where it is visible:
    // `ctx.services.getOptional` documents that optional services must be
    // resolved lazily rather than cached during activate().
    const requires = consumer?.plugin.requires ?? [];
    const consumerUnresolved: string[] = [];

    for (const rawReq of requires) {
      let req: CapabilityRef;
      try {
        req = parseCapabilityRef(rawReq);
      } catch {
        // manifestLoader already warned + dropped malformed entries; a
        // string that slipped through (e.g. ad-hoc test catalog) is
        // counted as unresolved so the consumer is held back instead of
        // silently activating with a missing dep.
        consumerUnresolved.push(rawReq);
        continue;
      }
      const providerId = findProvider(providerIndex, req);
      if (!providerId) {
        consumerUnresolved.push(rawReq);
        continue;
      }
      // Self-provide edges are dropped — a plugin that both provides and
      // requires the same cap doesn't create an ordering constraint.
      if (providerId !== consumerId) {
        edges.push({ from: providerId, to: consumerId });
      }
    }

    if (consumerUnresolved.length > 0) {
      unresolved.push({ consumerId, requires: consumerUnresolved });
    }
  }

  return { edges, unresolved, duplicateProviders };
}

export interface EligibleResolution {
  /** Plugin ids that are fully resolvable, in original input order. Pass
   *  this to `topoSortByDependsOn` together with {@link edges}. */
  resolved: string[];
  /** Provider→consumer edges among the resolved subset only. */
  edges: CapabilityEdge[];
  /** Every consumer that was dropped, with the raw requires that broke
   *  it. A dropped consumer's `requires` list may include caps that were
   *  satisfied in the first pass but lost their provider once another
   *  plugin in the cascade was dropped — the array reflects the final
   *  state, suitable for `markActivationFailed`. */
  unresolved: UnresolvedRequire[];
  /** Every duplicate provider dropped before resolving dependencies. */
  duplicateProviders: DuplicateProvider[];
}

/**
 * Iterative wrapper around {@link resolveCapabilities}. Drops every
 * duplicate provider or unresolved consumer, re-runs the single-pass on the
 * smaller set, and repeats until it stabilises. Cascade-safe: if A requires X
 * provided only by B, and B itself unresolved, the second pass drops A.
 *
 * Boot-time runtime callers should prefer this over the single-pass —
 * it ensures `topoSortByDependsOn` only sees fully-resolvable plugins.
 */
export function resolveEligiblePlugins(
  eligibleIds: readonly string[],
  catalog: PluginCatalog,
  options: CapabilityResolutionOptions = {},
): EligibleResolution {
  // Track the "final" unresolved entry per consumer — if a consumer is
  // dropped in pass N, that pass's `requires` list is the authoritative
  // one (it reflects what was missing once the eligible set already
  // shrank). We map by id to dedupe across passes.
  const finalUnresolved = new Map<string, string[]>();
  const finalDuplicates: DuplicateProvider[] = [];

  let current: readonly string[] = [...eligibleIds];
  let lastEdges: CapabilityEdge[] = [];

  // Bound the loop — at worst each pass drops at least one plugin, so
  // length+1 iterations is the worst case. Guards against any future
  // edge case where stabilisation isn't monotone.
  for (let i = 0; i <= eligibleIds.length; i++) {
    const { edges, unresolved, duplicateProviders } = resolveCapabilities(current, catalog, {
      ...options,
      onDuplicate: options.onDuplicate ?? 'errored',
    });
    if (unresolved.length === 0 && duplicateProviders.length === 0) {
      return {
        resolved: [...current],
        edges,
        unresolved: Array.from(finalUnresolved.entries()).map(
          ([consumerId, requires]) => ({ consumerId, requires }),
        ),
        duplicateProviders: finalDuplicates,
      };
    }
    for (const u of unresolved) {
      finalUnresolved.set(u.consumerId, u.requires);
    }
    finalDuplicates.push(...duplicateProviders);
    const drop = new Set([
      ...unresolved.map((u) => u.consumerId),
      ...duplicateProviders.map((d) => d.droppedId),
    ]);
    current = current.filter((id) => !drop.has(id));
    lastEdges = edges;
  }

  // Defensive — should never reach here because each pass reduces
  // `current` until either it's empty or stabilises. Surface as empty
  // resolved set rather than infinite loop.
  return {
    resolved: [...current],
    edges: lastEdges,
    unresolved: Array.from(finalUnresolved.entries()).map(
      ([consumerId, requires]) => ({ consumerId, requires }),
    ),
    duplicateProviders: finalDuplicates,
  };
}

// ---------------------------------------------------------------------------
// Install-time transitive walk (catalog + registry, server-side)
// ---------------------------------------------------------------------------

/**
 * Lightweight reference to a catalog plugin that *could* provide a
 * capability, plus its current install state. Surfaced to the frontend
 * via `details.available_providers` on a 409 install-blocked response.
 */
export interface CapabilityProviderRef {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  install_state: PluginInstallState;
  /** True iff the plugin is in `installedRegistry`. Independent of
   *  status — an `errored` plugin still counts as installed. */
  already_installed: boolean;
  /** True iff `installedRegistry.get(id).status === 'active'`. The
   *  wizard uses this to suggest "reactivate" vs. "install". */
  active: boolean;
}

export interface UnresolvedCapabilityEntry {
  /** Raw manifest string, e.g. `"knowledgeGraph@^1"`. */
  capability: string;
  /** Catalog plugins that publish a matching `<name>@<major>` in their
   *  `provides` list. Empty when the catalog has no candidate at all
   *  (operator must upload a provider package first). */
  providers: CapabilityProviderRef[];
}

export interface InstallChainResolution {
  /** Raw capability strings missing in the install-chain, in topo
   *  order: deepest pre-requisites first, target's direct requires
   *  last. The wizard installs in this order. */
  unresolved_requires: string[];
  /** Per-capability list of catalog providers. Same order as
   *  {@link unresolved_requires}. */
  available_providers: UnresolvedCapabilityEntry[];
}

/**
 * Find every catalog plugin that publishes a matching `<name>@<major>`
 * in its `provides` list. The result is unsorted; callers that need
 * stable ordering should sort by `id`.
 */
export function findCapabilityProvidersInCatalog(
  catalog: PluginCatalog,
  capRef: CapabilityRef,
): PluginCatalogEntry[] {
  const out: PluginCatalogEntry[] = [];
  for (const entry of catalog.list()) {
    for (const rawProv of entry.plugin.provides) {
      let ref: CapabilityRef;
      try {
        ref = parseCapabilityRef(rawProv);
      } catch {
        continue;
      }
      if (ref.name === capRef.name && ref.major === capRef.major) {
        out.push(entry);
        break;
      }
    }
  }
  return out;
}

/**
 * Install-time transitive resolver. Walks the target plugin's
 * `requires` chain, hopping through catalog providers, and accumulates
 * every capability that lacks an active provider in
 * `installedRegistry`. Server-side and complete: the result tells the
 * frontend exactly which capabilities the operator must address (and
 * which catalog plugins can provide them) before the target install
 * succeeds — no client-side recursion needed.
 *
 * The walk is bounded by `seenCaps` so a self-referential or cyclic
 * `provides`/`requires` graph cannot diverge.
 */
export function walkCapabilityInstallChain(
  targetPluginId: string,
  catalog: PluginCatalog,
  registry: InstalledRegistry,
): InstallChainResolution {
  const target = catalog.get(targetPluginId);
  if (!target) {
    return { unresolved_requires: [], available_providers: [] };
  }

  // Pre-compute the active-provider set so each capability check is O(1)
  // against the installed registry instead of re-scanning per cap.
  const activeProviderCaps = collectActiveProviderCaps(catalog, registry);

  interface Collected {
    capability: string;
    capRef: CapabilityRef;
    providers: PluginCatalogEntry[];
    depth: number;
  }
  const collected: Collected[] = [];
  const seenCaps = new Set<string>();
  const seenProviders = new Set<string>();

  const walk = (pluginId: string, depth: number): void => {
    const entry = catalog.get(pluginId);
    if (!entry) return;
    // `requires` only — an `optional_requires` entry (#795) is never a
    // reason to refuse an install, so it must not enter the chain. Nor is
    // its would-be provider walked: pulling an optional provider's own
    // unmet requires into the 409 would block the install on a plugin the
    // operator never asked for.
    for (const rawReq of entry.plugin.requires) {
      let capRef: CapabilityRef;
      try {
        capRef = parseCapabilityRef(rawReq);
      } catch {
        continue;
      }
      const capKey = `${capRef.name}@${capRef.major}`;
      if (seenCaps.has(capKey)) continue;
      seenCaps.add(capKey);

      // Already covered by an active provider — capability is satisfied,
      // no further walking needed.
      if (activeProviderCaps.has(capKey)) continue;

      const candidates = findCapabilityProvidersInCatalog(catalog, capRef);
      collected.push({
        capability: rawReq,
        capRef,
        providers: candidates,
        depth,
      });

      // Transitive: each candidate provider may itself have unmet
      // requires. Walk them at depth+1 so the topo-order
      // (deepest-first) places pre-reqs before the consumer.
      for (const cand of candidates) {
        if (seenProviders.has(cand.plugin.id)) continue;
        seenProviders.add(cand.plugin.id);
        walk(cand.plugin.id, depth + 1);
      }
    }
  };

  walk(targetPluginId, 0);

  // Deepest-first: a chained-install has to apply the leaves before the
  // target. Stable secondary sort on capability string keeps test
  // expectations deterministic.
  collected.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.capability.localeCompare(b.capability);
  });

  return {
    unresolved_requires: collected.map((c) => c.capability),
    available_providers: collected.map((c) => ({
      capability: c.capability,
      providers: c.providers
        .map((p) => toProviderRef(p, registry))
        .sort((x, y) => x.id.localeCompare(y.id)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ProviderCollision {
  readonly firstId: string;
  readonly secondId: string;
  readonly capability: string;
}

interface ProviderIndexScan {
  readonly index: Map<string, string>;
  readonly collision?: ProviderCollision;
}

/** OM-87 removes a losing plugin before rebuilding ALL provider slots.
 *  Keeping its other capabilities would let consumers activate against a
 *  plugin that never starts. Each collision removes one id, so this loop
 *  terminates after at most eligibleIds.length removals. */
function buildProviderIndex(
  eligibleIds: readonly string[],
  catalog: PluginCatalog,
  options: CapabilityResolutionOptions,
): { index: Map<string, string>; duplicateProviders: DuplicateProvider[] } {
  let current = eligibleIds;
  const duplicateProviders: DuplicateProvider[] = [];
  for (;;) {
    const { index, collision } = scanProviderIndex(current, catalog);
    if (!collision) return { index, duplicateProviders };
    const { firstId, secondId, capability } = collision;
    if ((options.onDuplicate ?? 'throw') === 'throw') {
      throw new Error(
        `capability '${capability}' is provided by both '${firstId}' and '${secondId}' — uninstall one`,
      );
    }
    const droppedId = pickDuplicateLoser(collision, options.installedAtById);
    const keptId = droppedId === firstId ? secondId : firstId;
    duplicateProviders.push({
      droppedId,
      keptId,
      capability,
      message: `capability '${capability}' is also provided by '${keptId}' — uninstall one`,
    });
    current = current.filter((id) => id !== droppedId);
  }
}

/** OM-87 compares actual instants, including ISO offsets. If either date
 *  is absent/invalid or both are equal, the first eligible id wins. Scan
 *  order survives filtering, making that fallback stable across boots.
 *  Pairwise scanning also avoids a non-transitive sort comparator when
 *  dated and undated entries are mixed. */
function pickDuplicateLoser(
  collision: ProviderCollision,
  installedAtById: ReadonlyMap<string, string> | undefined,
): string {
  const first = Date.parse(installedAtById?.get(collision.firstId) ?? '');
  const second = Date.parse(installedAtById?.get(collision.secondId) ?? '');
  return Number.isFinite(first) && Number.isFinite(second) && first > second
    ? collision.firstId
    : collision.secondId;
}

/** Scan in eligible and manifest order so strict collisions retain their
 *  existing message and boot has a deterministic first conflict to resolve. */
function scanProviderIndex(
  eligibleIds: readonly string[],
  catalog: PluginCatalog,
): ProviderIndexScan {
  const index = new Map<string, string>();
  for (const id of eligibleIds) {
    const entry = catalog.get(id);
    const provides = entry?.plugin.provides ?? [];
    for (const rawProv of provides) {
      let ref: CapabilityRef;
      try {
        ref = parseCapabilityRef(rawProv);
      } catch {
        // OM-87 preserves manifestLoader's malformed-provides policy:
        // it already warned, and an invalid declaration owns no slot.
        continue;
      }
      const key = capabilityKey(ref);
      const existing = index.get(key);
      if (existing && existing !== id) {
        return { index, collision: { firstId: existing, secondId: id, capability: rawProv } };
      }
      index.set(key, id);
    }
  }
  return { index };
}

function findProvider(
  index: Map<string, string>,
  req: CapabilityRef,
): string | undefined {
  return index.get(capabilityKey(req));
}

function capabilityKey(ref: CapabilityRef): string {
  return `${ref.name}@${ref.major}`;
}

/**
 * Walks the candidate plugin's `provides` list and returns the first
 * `<name>@<major>` slot that is already claimed by another active
 * installed plugin. Returns `null` when no collision — i.e. the install
 * would not introduce a duplicate provider.
 *
 * Server-side install-time check: prevents the persisted registry from
 * drifting into a state where boot must drop a duplicate provider
 * (OM-87 / #1053). Symmetric to the `requires`-chain walk in
 * {@link walkCapabilityInstallChain} — that one rejects on missing
 * providers; this one rejects on duplicate providers.
 */
export function findActiveProviderCollision(
  candidatePluginId: string,
  catalog: PluginCatalog,
  registry: InstalledRegistry,
): { capability: string; ownerId: string } | null {
  const candidate = catalog.get(candidatePluginId);
  if (!candidate) {
    return null;
  }
  return findProvidesCollision(
    candidatePluginId,
    candidate.plugin.provides,
    catalog,
    registry,
  );
}

/**
 * The same collision check, but driven by an explicit `provides` list rather
 * than a catalog lookup.
 *
 * Needed because the store must answer this question for plugins that are NOT
 * in the local catalog: a hub-only entry has no local manifest, yet it carries
 * `provides` from the registry summary, and it is exactly the case where the
 * store used to advertise an install that {@link findActiveProviderCollision}
 * would then refuse with 409 `install.capability_already_provided` (OM-06 /
 * issue #671). Asking with the list keeps both surfaces on one rule.
 */
export function findProvidesCollision(
  candidatePluginId: string,
  candidateProvides: readonly string[],
  catalog: PluginCatalog,
  registry: InstalledRegistry,
): { capability: string; ownerId: string } | null {
  const ownerByCap = new Map<string, string>();
  for (const installed of registry.list()) {
    if (installed.status !== 'active') {
      continue;
    }
    if (installed.id === candidatePluginId) {
      continue;
    }
    const entry = catalog.get(installed.id);
    if (!entry) {
      continue;
    }
    for (const rawProv of entry.plugin.provides) {
      try {
        const ref = parseCapabilityRef(rawProv);
        ownerByCap.set(capabilityKey(ref), installed.id);
      } catch {
        // manifestLoader already warned + dropped malformed entries; a
        // string that slipped through doesn't claim a slot.
      }
    }
  }
  for (const rawProv of candidateProvides) {
    let ref: CapabilityRef;
    try {
      ref = parseCapabilityRef(rawProv);
    } catch {
      continue;
    }
    const ownerId = ownerByCap.get(capabilityKey(ref));
    if (ownerId) {
      return { capability: rawProv, ownerId };
    }
  }
  return null;
}

/** Set of `<name>@<major>` keys that are currently published by an
 *  active installed plugin. Computed from registry × catalog so the
 *  install-chain walker can short-circuit on already-satisfied caps. */
function collectActiveProviderCaps(
  catalog: PluginCatalog,
  registry: InstalledRegistry,
): Set<string> {
  const out = new Set<string>();
  for (const installed of registry.list()) {
    if (installed.status !== 'active') continue;
    const entry = catalog.get(installed.id);
    if (!entry) continue;
    for (const rawProv of entry.plugin.provides) {
      try {
        const ref = parseCapabilityRef(rawProv);
        out.add(capabilityKey(ref));
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

function toProviderRef(
  entry: PluginCatalogEntry,
  registry: InstalledRegistry,
): CapabilityProviderRef {
  const installed = registry.get(entry.plugin.id);
  return providerRefFromPlugin(entry.plugin, installed?.status === 'active', !!installed);
}

function providerRefFromPlugin(
  plugin: Plugin,
  active: boolean,
  alreadyInstalled: boolean,
): CapabilityProviderRef {
  return {
    id: plugin.id,
    name: plugin.name,
    kind: plugin.kind,
    version: plugin.version,
    install_state: plugin.install_state,
    already_installed: alreadyInstalled,
    active,
  };
}
