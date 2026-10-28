/**
 * #1507 follow-ups.
 *
 *  - Uninstalling the LAST Privacy Shield provider is refused while the org
 *    policy `OMADIA_PRIVACY_FORCE_GUARDED=true` is on: without a provider the
 *    orchestrator runs every turn unmasked, which voids the policy.
 *  - The bypass resolver: a tool that already has an owner is decided by that
 *    owner alone. A sub-agent owner's `bypass` / `per_tool` setting reaches its
 *    sub-agent's toolkit tools, never an ownerless kernel tool or another
 *    agent's domain tool (security review of #1516).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyBypassResolver } from '../packages/harness-orchestrator/src/privacyBypassResolver.js';
import { InstallError, InstallService } from '../src/plugins/installService.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { uninstallVoidsForceGuarded } from '../src/plugins/privacyPosture.js';
import type { SecretVault } from '../src/secrets/vault.js';

const GUARD = '@omadia/plugin-privacy-guard';
const OTHER_GUARD = '@acme/other-shield';
const AGENT = '@omadia/agent-confluence';

function catalogOf(provides: Record<string, string[]>): PluginCatalog {
  return {
    get: (id: string) =>
      id in provides
        ? { plugin: { provides: provides[id], depends_on: [] } }
        : undefined,
    list: () => [],
  } as unknown as PluginCatalog;
}

async function registryWith(ids: string[]): Promise<InMemoryInstalledRegistry> {
  const registry = new InMemoryInstalledRegistry();
  for (const id of ids) {
    await registry.register({
      id,
      installed_version: '1.0.0',
      installed_at: '2026-10-28T08:00:00.000Z',
      status: 'active',
      config: {},
    });
  }
  return registry;
}

const FORCED = { OMADIA_PRIVACY_FORCE_GUARDED: 'true' } as NodeJS.ProcessEnv;

describe('#1507 — uninstalling the last shield under the org policy', () => {
  it('refuses with 409 install.privacy_guard_required and keeps the plugin', async () => {
    const registry = await registryWith([GUARD, AGENT]);
    const service = new InstallService({
      catalog: catalogOf({ [GUARD]: ['privacy.redact@1'], [AGENT]: [] }),
      registry,
      vault: {} as SecretVault,
      env: FORCED,
    });
    await assert.rejects(
      () => service.uninstall(GUARD),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === 'install.privacy_guard_required' &&
        err.status === 409,
    );
    assert.ok(registry.get(GUARD), 'the guard is still installed');
  });

  it('allows it without the policy, for a second provider, and for other plugins', async () => {
    const registry = await registryWith([GUARD, OTHER_GUARD, AGENT]);
    const one = catalogOf({ [GUARD]: ['privacy.redact@1'], [AGENT]: [] });
    const two = catalogOf({
      [GUARD]: ['privacy.redact@1'],
      [OTHER_GUARD]: ['privacy.redact@1'],
      [AGENT]: [],
    });
    const base = { pluginId: GUARD, installedRegistry: registry };
    assert.equal(uninstallVoidsForceGuarded({ ...base, catalog: one, env: {} }), false);
    assert.equal(
      uninstallVoidsForceGuarded({ ...base, catalog: one, env: { OMADIA_PRIVACY_FORCE_GUARDED: '1' } }),
      false,
      'only exactly "true" is the policy',
    );
    assert.equal(uninstallVoidsForceGuarded({ ...base, catalog: two, env: FORCED }), false);
    assert.equal(
      uninstallVoidsForceGuarded({ ...base, pluginId: AGENT, catalog: one, env: FORCED }),
      false,
    );
    // Sanity: the same inputs with the policy and one provider DO block.
    const single = await registryWith([GUARD, AGENT]);
    assert.equal(
      uninstallVoidsForceGuarded({ pluginId: GUARD, installedRegistry: single, catalog: one, env: FORCED }),
      true,
    );
  });
});

describe('privacy bypass resolver — an owned tool never falls through', () => {
  const configs: Record<string, Record<string, unknown>> = {
    // The sub-agent owner: bypass for everything.
    '@omadia/agent-a': { _privacy_mode: 'bypass' },
    // An agent that names foreign tools in its per-tool list.
    '@omadia/agent-b': {
      _privacy_mode: 'per_tool',
      _privacy_bypass_scopes: ['memory', 'query_other', 'confluence_search'],
    },
    // Another agent that stays guarded (default).
    '@omadia/agent-other': {},
  };

  function resolver(owner: string | undefined, env: NodeJS.ProcessEnv = {}) {
    return createPrivacyBypassResolver({
      mcpBypassInForce: () => undefined,
      nativeTool: (name) =>
        name === 'memory'
          ? {} // ownerless kernel registration
          : name === 'odoo_read'
            ? {
                agentId: '@omadia/integration-odoo',
                readConfig: () => undefined, // guarded
              }
            : undefined,
      isDomainTool: (name) => name === 'query_other',
      domainToolAgentId: (name) =>
        name === 'query_other' ? '@omadia/agent-other' : undefined,
      pluginConfigGet: (agentId, key) => configs[agentId]?.[key],
      subAgentOwner: () => owner,
      env,
    });
  }

  it("bypasses the owner's sub-agent toolkit tools", () => {
    assert.deepEqual(resolver('@omadia/agent-a')('confluence_search'), {
      pluginId: '@omadia/agent-a',
    });
    assert.deepEqual(resolver('@omadia/agent-b')('confluence_search'), {
      pluginId: '@omadia/agent-b',
    });
    assert.equal(resolver('@omadia/agent-b')('confluence_get_page'), undefined);
  });

  it('keeps an ownerless kernel tool guarded whatever the sub-agent owner says', () => {
    assert.equal(resolver('@omadia/agent-a')('memory'), undefined);
    assert.equal(resolver('@omadia/agent-b')('memory'), undefined);
  });

  it("keeps another agent's domain tool on that agent's own setting", () => {
    assert.equal(resolver('@omadia/agent-a')('query_other'), undefined);
    assert.equal(resolver('@omadia/agent-b')('query_other'), undefined);
  });

  it("keeps a plugin-registered kernel tool on its plugin's setting", () => {
    assert.equal(resolver('@omadia/agent-a')('odoo_read'), undefined);
  });

  it('honours the org clamp on every path', () => {
    const forced = resolver('@omadia/agent-a', FORCED);
    assert.equal(forced('confluence_search'), undefined);
  });
});
