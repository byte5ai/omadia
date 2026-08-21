/**
 * Grant gate for `ctx.services.get` — epic #470, bug B1.
 *
 * WHAT WAS WRONG
 * --------------
 * `pluginContext.ts` exposed the service registry as a bare pass-through:
 *
 *     get<T>(name: string) { return serviceRegistry.get<T>(name); }
 *
 * Any installed plugin could therefore ask for any registered service —
 * `graphPool` (the same Postgres pool core uses), `tigrisStore`,
 * `anthropicClient` — with no manifest declaration, no operator consent, and
 * nothing about it in the install dialog. `serviceRegistry.ts`'s own header
 * conceded the design: *"This registry is a naked service-locator; enforcement
 * lives at the consumer seam."* This file IS that seam.
 *
 * THE RULE
 * --------
 * The service-registry key IS the capability name — `pluginContext.ts` states
 * it in the capability docblock ("Capability-names are ALSO used as
 * service-registry keys"), and every provider follows it. So the manifest
 * already carries the declaration the gate needs, and no new manifest field is
 * invented here:
 *
 *   - `requires: ["knowledgeGraph@^1"]` grants `get('knowledgeGraph')`.
 *   - `optional_requires: ["turnContext@1"]` grants `get('turnContext')` and
 *     `getOptional('turnContext')` without making the capability an
 *     activation prerequisite (#795).
 *   - `provides: ["memoryStore@1"]`     grants `get('memoryStore')` ONCE the
 *     plugin has actually called `provide('memoryStore', …)` — see below.
 *   - anything else throws `ServiceNotDeclaredError`, naming both the
 *     capability and the manifest field that would grant it.
 *
 * WHY `provides:` IS NOT ENOUGH ON ITS OWN (issue #788)
 * ----------------------------------------------------
 * The original reading was "a plugin may always read back its own
 * registration; it holds the implementation anyway, so this is not an
 * escalation". The premise is right and the conclusion followed from it — but
 * the gate never checked the premise. `provides:` is a self-declaration that,
 * unlike `requires:`, costs nothing: it creates no activation edge, holds
 * nothing back, and cannot fail an install. So `provides: ["graphPool@1"]` in
 * an uploaded manifest bought `get('graphPool')` — the operator's Postgres
 * pool, registered by somebody else entirely — for the price of one YAML line.
 * That is an undeclared-capability bypass wearing a declaration's clothes, and
 * it is strictly WEAKER than the `requires:` path it sits beside: `requires:`
 * at least shows up in the install dialog and in dependency resolution.
 *
 * So the grant now needs the fact as well as the claim. `ServiceRegistry`
 * tracks live registrations per owning agentId (`providedBy`), and a name
 * declared ONLY under `provides:` resolves only while the asking plugin holds
 * a live registration for it. Order matters and is the point: `provide()`
 * first, `get()` after. A plugin that reads before it registers gets a throw
 * that says exactly that (`reason: 'provides-not-registered'`) rather than
 * somebody else's object.
 *
 * A name in BOTH `requires:` and `provides:` is unaffected — the `requires:`
 * declaration grants it outright, because a plugin that declares a dependency
 * has already paid the dependency's price.
 *
 * AUDIT (2026-08-21). Every bundled package under `middleware/packages/*` and
 * every sibling plugin repo under `~/sources/omadia-*` was scanned for a
 * `services.get(name)` where `name` appears only in that manifest's
 * `provides:`. Fourteen packages declare `provides:` at all; none of them read
 * a provides-only name back, in comments or in code, so this tightening
 * grandfathers nothing and needs no allowlist row. The permanent guard lives
 * in `test/pluginServiceGrantCoverage.test.ts`, which re-runs that scan over
 * the bundled packages with the TypeScript checker rather than a regex.
 *
 * WHY THERE IS AN ALLOWLIST
 * -------------------------
 * A call-site audit across this repo's built-in plugin packages and all ten
 * sibling plugin repos (`~/sources/omadia-*`) found that today's `requires:`
 * lists are far from complete — 63 (plugin, capability) pairs are consumed
 * without being declared. Turning the gate fail-closed in one step would break
 * every one of them, including shipped Hub plugins this PR cannot edit.
 *
 * So the gate is fail-closed for everything EXCEPT the exact pairs the audit
 * found, which warn once and resolve. The allowlist is dated, closed, and
 * keyed per plugin id: a *different* plugin asking for `graphPool` still
 * throws, and a *new* undeclared name in an allowlisted plugin still throws.
 * It grandfathers history, it does not open a door.
 *
 * Two of the entries are not laziness but a genuine naming defect worth
 * recording: `harness-plugin-privacy-guard` declares the capability
 * `privacy.redact@1` but registers the service under the key `privacyRedact`.
 * Capability name and service key disagree, so no `requires:` entry could
 * grant it. That mismatch has to be fixed on one side or the other before the
 * corresponding allowlist rows can be dropped.
 *
 * The first audit missed some rows for two concrete reasons: several service
 * names are hidden behind exported constants (`NUDGE_STATE_SERVICE_NAME`,
 * `PROCESS_MEMORY_SERVICE_NAME`, `PLUGIN_CAPABILITIES_SERVICE`, …) instead of
 * literal strings, and some channel plugins resolve capabilities through
 * shared `@omadia/channel-sdk` helpers rather than a literal
 * `ctx.services.get('...')` inside the plugin's own source file.
 *
 * RETIRING IT
 * -----------
 * Each row is retired by adding the capability to that plugin's manifest. Until
 * #795 that was not always possible: `requires:` is also the *activation*
 * dependency (`resolveEligiblePlugins` holds back a consumer whose requires are
 * unmet), so declaring an optionally-consumed service would have made it
 * mandatory and could have stopped the plugin activating. `optional_requires:`
 * now expresses exactly that case — it grants the same declaration this gate
 * asks for and creates no activation prerequisite — so every remaining row here
 * has a manifest fix available and the allowlist can be drained.
 */

import {
  ServiceNotDeclaredError,
  parseCapabilityRef,
} from '@omadia/plugin-api';
import type { ServiceGateOperation } from '@omadia/plugin-api';

import type { PluginCatalog } from '../plugins/manifestLoader.js';

/**
 * The half of the audit that lives in THIS repository — `middleware/packages/*`.
 *
 * Reachable only when the catalog says `origin === 'bundled'`, which the loader
 * stamps from WHERE the package was found and never reads from a manifest.
 * That is the whole of the #789 fix for these ids, and it matters most here:
 * `@omadia/orchestrator` alone carries nineteen names including `graphPool`
 * (the operator's Postgres pool) and `tigrisStore`. `PluginCatalog` documents
 * that an uploaded package wins an `identity.id` collision, so before this gate
 * a zip claiming that id inherited all nineteen without declaring one of them.
 * Same mechanism and same fail-closed default as `LEGACY_SQL_GRANTS_2026_08_20`
 * in `pluginSqlGrants.ts`.
 *
 * An id here that STOPS being bundled (extracted to its own repo, the way the
 * channel plugins were) drops to `[]` rather than falling through to the
 * standalone table. That is deliberate: leaving the repo is exactly when a
 * grant deserves a fresh audit, and a silent carry-over would be a grant nobody
 * re-checked.
 */
export const BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  '@omadia/plugin-office': Object.freeze(['privacyRedact']),
  '@omadia/verifier': Object.freeze(['graphPool', 'odoo.client']),
  '@omadia/knowledge-graph-inmemory': Object.freeze(['turnContext']),
  '@omadia/knowledge-graph-neon': Object.freeze(['turnContext']),
  '@omadia/diagrams': Object.freeze(['memoryStore']),
  '@omadia/ui-orchestrator': Object.freeze([
    'agentToolInvoker',
    'canvasOutputRegistry',
    'deterministicActionRegistry',
  ]),
  '@omadia/plugin-plan-runner': Object.freeze([
    'knowledgeGraph',
    'processMemory',
    'turnHookRegistry',
  ]),
  '@omadia/orchestrator-extras': Object.freeze([
    'agentPriorities',
    'graphPool',
    'processMemory',
  ]),
  '@omadia/ui-channel': Object.freeze(['graphTenantId']),
  '@omadia/orchestrator': Object.freeze([
    'attachmentBindings',
    'audienceGrants',
    'graphPool',
    'installedPluginConfigReader',
    'installedPluginToolsReadyReader',
    'llmProviderCatalog',
    'microsoft365.graph',
    'nativeToolRegistry',
    'nudgeProviders',
    'nudgeStateStore',
    'palaiaExcerpt',
    'pluginCapabilities',
    'privacyRedact',
    'processMemory',
    'responseGuard',
    'sessionBriefing',
    'tigrisStore',
    'turnHookRegistry',
    'turnReceiptStore',
  ]),
});

/**
 * The half of the audit that ships from `hub.omadia.ai` — one repository per
 * plugin, arriving as an installed package.
 *
 * WHY THESE ARE NOT ORIGIN-GATED, AND WHAT THAT COSTS
 * ---------------------------------------------------
 * They cannot be: they are never `bundled`. Gating them on origin would return
 * `[]` for every one of them, and a re-audit on 2026-08-21 confirmed all nine
 * rows are still load-bearing — not one of the sibling manifests declares its
 * allowlisted names yet. `@omadia/channel-teams` alone would lose thirteen,
 * `graphPool` and `anthropicClient` among them, at the first turn after the
 * upgrade. That is the #794 trap at customer scale, and this repo has sprung it
 * once already.
 *
 * So for these ids the key stays the id, and the id is not a credential —
 * nothing today distinguishes the real `@omadia/channel-teams` zip from a zip
 * that merely says so. What #789 CAN close, and this file does close, is the
 * neighbouring case where the claimed id belongs to a package this repo ships:
 * see {@link legacyServiceGrantsFor}, which refuses the ramp to any installed
 * package whose id the catalog knows as bundled, and the ingest refusal in
 * `plugins/packageUploadService.ts` that stops such a zip landing at all.
 *
 * The residual is a zip claiming one of the nine ids below on a host where that
 * plugin is not installed. Closing it needs package provenance — a signature
 * the Hub issues and the middleware verifies — not a longer list. Until then
 * the mitigation is retirement: each row dies the moment the sibling repo's
 * `manifest.yaml` declares the capability under `requires:` or
 * `optional_requires:`, which is a one-line change in nine repositories and
 * needs no coordination with this one.
 */
export const STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  '@omadia/channel-discord': Object.freeze([
    'channelResolver',
    'chatAgent',
  ]),
  '@omadia/channel-slack': Object.freeze([
    'channelResolver',
    'chatAgent',
  ]),
  '@omadia/channel-teams': Object.freeze([
    'anthropicClient',
    'channelDirectoryRegistry',
    'channelResolver',
    'conductorAwaitResolver',
    'embeddingClient',
    'graphPool',
    'graphTenantId',
    'microsoft365.graph',
    'routinesIntegration',
    'tigrisStore',
    'topicDetector',
    'turnContext',
    'uiRouteCatalog',
  ]),
  '@omadia/channel-telegram': Object.freeze([
    'channelResolver',
    'memoryStore',
    'turnContext',
  ]),
  '@omadia/channel-whatsapp': Object.freeze([
    'channelResolver',
    'chatAgent',
  ]),
  '@omadia/integration-odoo': Object.freeze(['entityRefBus']),
  '@omadia/agent-odoo-hr': Object.freeze([
    'odoo.agentToolkit.hr',
    'odoo.client',
  ]),
  '@omadia/agent-odoo-accounting': Object.freeze([
    'odoo.agentToolkit.accounting',
  ]),
  '@omadia/agent-confluence': Object.freeze([
    'confluence.client',
    'confluence.toolkit',
  ]),
});

/**
 * Audited legacy grants — snapshot taken 2026-08-20.
 *
 * Keyed by the kernel-known plugin id, valued with the exact service names
 * that plugin resolves today without declaring them. CLOSED SET: adding a row
 * means a shipped plugin regressed and needs a manifest fix, not a wider gate.
 *
 * Sources: `middleware/packages/*` (built-ins) and the ten standalone plugin
 * repos under `~/sources/omadia-*`, read at their `main`.
 *
 * SPLIT BY ORIGIN (issue #789). This constant is the UNION of the two tables
 * below and exists so the audit record can still be read in one piece. Nothing
 * consults it to make a decision — every grant goes through {@link
 * legacyServiceGrantsFor}, which picks the table by the catalog's `origin`.
 */
export const LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  ...BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20,
  ...STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20,
});

/**
 * The legacy ramp in force for one plugin — issue #789.
 *
 * The ONLY reader of the two tables above. Three branches, each answering a
 * different question the id alone cannot:
 *
 *  1. `origin === 'bundled'` — this is a package the middleware image ships.
 *     It gets its bundled row, and nothing else: an id that has since left the
 *     tree is not carried over from the standalone table.
 *  2. installed, but the catalog knows the id as bundled — an upload or a
 *     local-dev package is SHADOWING code we ship (`PluginCatalog` resolves an
 *     `identity.id` collision in the upload's favour). It inherits nothing.
 *     This is #789's reported case.
 *
 *     For UPLOADS this branch is a second lock: `packageUploadService.ts`
 *     refuses such a zip at ingest, so it normally never gets this far.
 *     For LOCAL-DEV packages (`PLUGIN_DEV_DIR`) this branch is the ONLY lock —
 *     `LocalDevPackageStore` feeds `extraSources` straight from the
 *     filesystem and never touches `ingest`, so no refusal runs on that path.
 *     That is deliberate rather than an oversight: `PLUGIN_DEV_DIR` is an
 *     operator-set env var pointing at a directory the operator controls, so
 *     shadowing a bundled id from it is a supported local workflow. What is
 *     NOT supported is inheriting the shadowed id's grants, and this branch is
 *     what denies them on both paths.
 *  3. installed, and the id is not one this repo bundles — a Hub plugin. Its
 *     standalone row applies; see that table's docblock for what that costs and
 *     how it retires.
 *
 * A plugin the catalog cannot resolve gets `[]`. Same fail-closed reading as
 * `declaredServiceNames` and `bundledSqlRampCapabilities`: an id whose manifest
 * the kernel cannot find is an id whose permissions cannot be checked.
 */
export function legacyServiceGrantsFor(
  agentId: string,
  catalog: PluginCatalog,
): readonly string[] {
  const bundledRow = BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20[agentId];
  const standaloneRow = STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20[agentId];
  // The overwhelmingly common case: an id on neither dated list. Answered
  // before the catalog is touched at all, so the ramp costs one map lookup per
  // `get` for every plugin that is not being grandfathered.
  if (bundledRow === undefined && standaloneRow === undefined) return [];

  const entry = catalog.get(agentId);
  if (entry === undefined) return [];
  if (entry.origin === 'bundled') return bundledRow ?? [];
  if (catalog.isBundledId(agentId)) return [];
  return standaloneRow ?? [];
}

/** Why a `services.get` call was allowed — or wasn't. */
export type ServiceGrantOutcome =
  | 'declared'
  | 'self-provided'
  | 'legacy-allowlist'
  | 'provides-not-registered'
  | 'undeclared';

/**
 * Every capability name the plugin's manifest declares — `requires` (consume)
 * plus `provides` (read back its own registration).
 *
 * A plugin with no catalog entry declares nothing, so it is granted nothing.
 * That mirrors `scratchEnabled`, which also denies on an absent entry: an id
 * the kernel cannot find a manifest for is an id whose permissions cannot be
 * checked, and unknown permissions are denied permissions.
 */
export function declaredServiceNames(
  agentId: string,
  catalog: PluginCatalog,
): ReadonlySet<string> {
  const entry = catalog.get(agentId);
  if (!entry) return new Set<string>();
  const names = new Set<string>();
  for (const raw of [
    ...(entry.plugin.requires ?? []),
    // #795 — an optional dependency is still a DECLARATION. It says "I may
    // resolve this", which is exactly the question this gate asks; what it
    // does not say is "hold my activation until someone provides it", which
    // is a different gate (capabilityResolver) and stays untouched. Without
    // this line the two gates contradict each other: C2b would demand the
    // capability be listed, and listing it under `requires:` would make a
    // degradable dependency mandatory.
    ...(entry.plugin.optional_requires ?? []),
    ...(entry.plugin.provides ?? []),
  ]) {
    try {
      names.add(parseCapabilityRef(raw).name);
    } catch {
      // Malformed entry — the loader already warned. A name we cannot parse
      // grants nothing, which is the fail-closed direction.
    }
  }
  return names;
}

/** Parse a list of capability refs into bare names, dropping malformed ones —
 *  a name that cannot be parsed grants nothing, the fail-closed direction. */
function namesOf(refs: readonly string[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  for (const raw of refs ?? []) {
    try {
      names.add(parseCapabilityRef(raw).name);
    } catch {
      // The loader already warned about this entry.
    }
  }
  return names;
}

/**
 * Classify one `services.get(name)` call. Pure — no logging, no throwing, so
 * it can be asserted directly in tests.
 *
 * `isRegisteredByPlugin` answers "does this plugin hold a LIVE registration for
 * `name` right now?" (issue #788). It is a required argument rather than an
 * optional one because there is no defensible default: `() => true` restores
 * the bypass, and `() => false` would silently deny a legitimate provider at a
 * call site that simply forgot to wire the registry. Forcing every caller to
 * answer is the point.
 */
export function classifyServiceGrant(
  agentId: string,
  name: string,
  declared: ReadonlySet<string>,
  catalog: PluginCatalog,
  isRegisteredByPlugin: (name: string) => boolean,
): ServiceGrantOutcome {
  if (declared.has(name)) {
    const plugin = catalog.get(agentId)?.plugin;
    // A dependency declaration grants the name outright — it was paid for at
    // activation. Checked FIRST so a plugin that both consumes and re-provides
    // a capability (the `replace()` wrapping pattern) is untouched by #788.
    const consumeDeclared =
      namesOf(plugin?.requires).has(name) ||
      namesOf(plugin?.optional_requires).has(name);
    if (consumeDeclared) return 'declared';
    // #788 — `provides:` alone is a claim; a live registration is the fact
    // behind it. Without the fact, resolving the name would hand over whatever
    // OTHER plugin registered it, which is the bypass this closes.
    if (namesOf(plugin?.provides).has(name)) {
      return isRegisteredByPlugin(name)
        ? 'self-provided'
        : 'provides-not-registered';
    }
    // `declared` said yes but no manifest field claims the name: only
    // reachable if a caller passed a set that did not come from
    // `declaredServiceNames`. Treat the manifest as authoritative.
    return 'declared';
  }
  if (legacyServiceGrantsFor(agentId, catalog).includes(name)) {
    return 'legacy-allowlist';
  }
  return 'undeclared';
}

export interface ServiceGrantGateOptions {
  agentId: string;
  catalog: PluginCatalog;
  /**
   * #788 — whether this plugin currently holds a live registration for the
   * name. `createPluginContext` supplies
   * `(name) => serviceRegistry.providedBy(agentId, name)`, with `agentId` the
   * kernel-known id, so a plugin cannot answer the question about itself.
   *
   * Evaluated per call, not once when the gate is built: a context is created
   * at activation, BEFORE the plugin's `activate()` has had the chance to
   * `provide()` anything, so a snapshot taken here would deny every provider
   * its own capability forever.
   */
  isRegisteredByPlugin: (name: string) => boolean;
  /** Where the one-time legacy warning goes. */
  log: (...args: unknown[]) => void;
}

/**
 * Build the per-plugin gate. The returned function is called for every
 * `ctx.services.get(name)` and either returns (allowed) or throws
 * {@link ServiceNotDeclaredError}.
 *
 * The declared set is computed once per plugin context rather than per call:
 * a context is created at activation and the manifest cannot change under a
 * live plugin.
 *
 * Legacy warnings are emitted once per (plugin, capability) so a service
 * resolved inside a per-turn hot path cannot flood the log.
 */
export function createServiceGrantGate(
  opts: ServiceGrantGateOptions,
): (name: string, operation?: ServiceGateOperation) => void {
  const { agentId, catalog, isRegisteredByPlugin, log } = opts;
  const declared = declaredServiceNames(agentId, catalog);
  const warned = new Set<string>();

  return function assertServiceGranted(
    name: string,
    operation: ServiceGateOperation = 'get',
  ): void {
    const outcome = classifyServiceGrant(
      agentId,
      name,
      declared,
      catalog,
      isRegisteredByPlugin,
    );
    if (outcome === 'undeclared') {
      throw new ServiceNotDeclaredError(agentId, name, 'undeclared', operation);
    }
    // #788 — a distinct reason, because it has a distinct fixer. 'undeclared'
    // sends the author to the manifest; this one sends them to the ORDER of
    // two calls they have already written.
    if (outcome === 'provides-not-registered') {
      throw new ServiceNotDeclaredError(
        agentId,
        name,
        'provides-not-registered',
        operation,
      );
    }
    if (outcome === 'legacy-allowlist' && !warned.has(name)) {
      warned.add(name);
      // Warned once per (plugin, capability) — NOT per (plugin, capability,
      // operation). A plugin on the ramp that both resolves and replaces a
      // name has one manifest line to fix, so one warning is the honest count.
      log(
        `[services] '${agentId}' resolved '${name}' without declaring it — allowed by the dated legacy allowlist (2026-08-20). ` +
          `Add '${name}@<major>' to the plugin's manifest \`requires:\`; the allowlist is a migration ramp, not a permission.`,
      );
    }
  };
}
