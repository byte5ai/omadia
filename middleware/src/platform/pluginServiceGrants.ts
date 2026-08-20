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
 *   - `provides: ["memoryStore@1"]`     grants `get('memoryStore')` — a plugin
 *     may always read back its own registration; it holds the implementation
 *     anyway, so this is not an escalation.
 *   - anything else throws `ServiceNotDeclaredError`, naming both the
 *     capability and the manifest field that would grant it.
 *
 * WHY THERE IS AN ALLOWLIST
 * -------------------------
 * A call-site audit across this repo's built-in plugin packages and all ten
 * sibling plugin repos (`~/sources/omadia-*`) found that today's `requires:`
 * lists are far from complete — 27 (plugin, capability) pairs are consumed
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
 * RETIRING IT
 * -----------
 * Each row is retired by adding the capability to that plugin's manifest — but
 * note `requires:` is also the *activation* dependency (`resolveEligiblePlugins`
 * holds back a consumer whose requires are unmet), so a plugin that consumes a
 * service *optionally* cannot express that today. Declaring it would make an
 * optional dependency mandatory and could stop the plugin activating. That
 * missing "optional requires" expression is the open design question this
 * allowlist defers, not a shortcut around work that is already possible.
 */

import {
  ServiceNotDeclaredError,
  parseCapabilityRef,
} from '@omadia/plugin-api';

import type { PluginCatalog } from '../plugins/manifestLoader.js';

/**
 * Audited legacy grants — snapshot taken 2026-08-20.
 *
 * Keyed by the kernel-known plugin id, valued with the exact service names
 * that plugin resolves today without declaring them. CLOSED SET: adding a row
 * means a shipped plugin regressed and needs a manifest fix, not a wider gate.
 *
 * Sources: `middleware/packages/*` (built-ins) and the ten standalone plugin
 * repos under `~/sources/omadia-*`, read at their `main`.
 */
export const LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  // -- built-in plugin packages (middleware/packages/*) ---------------------
  '@omadia/plugin-office': Object.freeze(['privacyRedact']),
  '@omadia/verifier': Object.freeze(['graphPool', 'odoo.client']),
  '@omadia/knowledge-graph-inmemory': Object.freeze(['turnContext']),
  '@omadia/knowledge-graph-neon': Object.freeze(['turnContext']),
  '@omadia/diagrams': Object.freeze(['memoryStore']),
  '@omadia/plugin-plan-runner': Object.freeze([
    'knowledgeGraph',
    'processMemory',
    'turnHookRegistry',
  ]),
  '@omadia/orchestrator-extras': Object.freeze(['agentPriorities', 'graphPool']),
  '@omadia/ui-channel': Object.freeze(['graphTenantId']),
  '@omadia/orchestrator': Object.freeze([
    'attachmentBindings',
    'audienceGrants',
    'graphPool',
    'nudgeProviders',
    'privacyRedact',
    'responseGuard',
    'sessionBriefing',
    'tigrisStore',
    'turnHookRegistry',
    'turnReceiptStore',
  ]),
  // -- standalone plugin repos (shipped via hub.omadia.ai) -----------------
  '@omadia/channel-teams': Object.freeze([
    'anthropicClient',
    'embeddingClient',
    'graphPool',
    'graphTenantId',
    'microsoft365.graph',
    'tigrisStore',
    'topicDetector',
    'turnContext',
  ]),
  '@omadia/channel-telegram': Object.freeze(['memoryStore', 'turnContext']),
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

/** Why a `services.get` call was allowed — or wasn't. */
export type ServiceGrantOutcome =
  | 'declared'
  | 'self-provided'
  | 'legacy-allowlist'
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

/** Classify one `services.get(name)` call. Pure — no logging, no throwing, so
 *  it can be asserted directly in tests. */
export function classifyServiceGrant(
  agentId: string,
  name: string,
  declared: ReadonlySet<string>,
  catalog: PluginCatalog,
): ServiceGrantOutcome {
  if (declared.has(name)) {
    const entry = catalog.get(agentId);
    const provides = entry?.plugin.provides ?? [];
    const selfProvided = provides.some((raw) => {
      try {
        return parseCapabilityRef(raw).name === name;
      } catch {
        return false;
      }
    });
    return selfProvided ? 'self-provided' : 'declared';
  }
  const legacy = LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20[agentId];
  if (legacy?.includes(name)) return 'legacy-allowlist';
  return 'undeclared';
}

export interface ServiceGrantGateOptions {
  agentId: string;
  catalog: PluginCatalog;
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
): (name: string) => void {
  const { agentId, catalog, log } = opts;
  const declared = declaredServiceNames(agentId, catalog);
  const warned = new Set<string>();

  return function assertServiceGranted(name: string): void {
    const outcome = classifyServiceGrant(agentId, name, declared, catalog);
    if (outcome === 'undeclared') {
      throw new ServiceNotDeclaredError(agentId, name);
    }
    if (outcome === 'legacy-allowlist' && !warned.has(name)) {
      warned.add(name);
      log(
        `[services] '${agentId}' resolved '${name}' without declaring it — allowed by the dated legacy allowlist (2026-08-20). ` +
          `Add '${name}@<major>' to the plugin's manifest \`requires:\`; the allowlist is a migration ramp, not a permission.`,
      );
    }
  };
}
