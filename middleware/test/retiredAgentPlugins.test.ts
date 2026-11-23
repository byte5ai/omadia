/**
 * Spec 2042 §5.10, ADR-0014 (S3c) — the kernel has no runtime for the retired
 * kind `agent`. A package of that kind still installed from before is left
 * `errored` with the code `kind_retired`, at boot and on every reactivation;
 * it never crashes the boot and keeps its config for the version that
 * replaces it.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { activationResultOf, classifyActivationError } from '../src/plugins/activationFailure.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { blockRetiredAgentPlugins, RetiredPluginKindError } from '../src/plugins/retiredAgentPlugins.js';

const AGENT = 'de.byte5.agent.legacy';
const TOOL = '@omadia/integration-odoo';

function catalog(kinds: Record<string, string>) {
  return {
    get: (id: string) => (kinds[id] ? ({ plugin: { id, kind: kinds[id] } } as never) : undefined),
  };
}

async function registryWith(...ids: string[]): Promise<InMemoryInstalledRegistry> {
  const registry = new InMemoryInstalledRegistry();
  for (const id of ids) {
    await registry.register({
      id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: { region: 'eu' },
    });
  }
  return registry;
}

describe('retired agent plugins (S3c)', () => {
  it('records an installed agent plugin as errored with kind_retired and a message that says what to do', async () => {
    const registry = await registryWith(AGENT, TOOL);
    const logs: string[] = [];
    const blocked = await blockRetiredAgentPlugins({
      registry,
      catalog: catalog({ [AGENT]: 'agent', [TOOL]: 'integration' }),
      log: (m) => logs.push(m),
    });

    assert.deepEqual(blocked, [AGENT]);
    const result = activationResultOf(registry.get(AGENT));
    assert.equal(result?.state, 'errored');
    assert.equal(result?.error_code, 'kind_retired');
    assert.match(result?.error ?? '', /retired kind 'agent'.*update it .* or uninstall it/);
    assert.deepEqual(registry.get(AGENT)?.config, { region: 'eu' }, 'its config stays for the replacing version');
    assert.equal(registry.get(TOOL)?.status, 'active', 'other plugins are untouched');
    assert.equal(logs.length, 1);
  });

  it('never throws when the registry write fails, and goes on with the next plugin', async () => {
    const written: string[] = [];
    const registry = {
      list: () => [{ id: 'a.one' }, { id: 'a.two' }] as never,
      markActivationBlocked: async (id: string) => {
        if (id === 'a.one') throw new Error('disk full');
        written.push(id);
      },
    };
    const logs: string[] = [];
    const blocked = await blockRetiredAgentPlugins({
      registry,
      catalog: catalog({ 'a.one': 'agent', 'a.two': 'agent' }),
      log: (m) => logs.push(m),
    });
    assert.deepEqual(blocked, ['a.two']);
    assert.deepEqual(written, ['a.two']);
    assert.ok(logs.some((m) => m.includes("could not record 'a.one'") && m.includes('disk full')));
  });

  it('a reactivation throws an error the install service classifies as kind_retired', () => {
    assert.equal(classifyActivationError(new RetiredPluginKindError(AGENT)), 'kind_retired');
  });

  it('the boot records them after the tool runtime started, and every dispatch site has a branch for them', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const toolBoot = source.indexOf('await toolPluginRuntime.activateAllInstalled()');
    const retired = source.indexOf('await blockRetiredAgentPlugins(');
    assert.ok(toolBoot > 0 && retired > toolBoot, 'blockRetiredAgentPlugins runs after the tool runtime boot');
    assert.equal(source.includes('DynamicAgentRuntime'), false, 'no agent runtime is wired');
    assert.equal(source.match(/throw new RetiredPluginKindError\(agentId\)/g)?.length, 2, 'install and update refuse to start one');
  });
});
