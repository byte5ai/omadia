import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createOrchestratorToolRebinder,
  hydrateAgentRegistry,
} from '../src/agents/runtimeToolPropagation.js';

interface Built {
  readonly tools: string[];
}

function fakeRegistry(slugs: string[]) {
  const entries = slugs.map((slug) => ({ agent: { slug }, built: { tools: [] as string[] } }));
  let onBuilt: ((slug: string, built: Built) => void) | undefined;
  return {
    entries,
    list: () => entries,
    setOnAgentBuilt: (cb: (slug: string, built: Built) => void) => {
      onBuilt = cb;
    },
    rebuild(slug: string): Built {
      const built: Built = { tools: [] };
      onBuilt?.(slug, built);
      return built;
    },
  };
}

/** Registers one sub-agent tool named after the Agent. */
const subAgentTools = (slug: string, built: Built): number => {
  built.tools.push(`ask_${slug}_helper`);
  return 1;
};

test('hydrateAgentRegistry: registers every Agent’s sub-agent tools and counts them', () => {
  const reg = fakeRegistry(['fallback', 'marketing']);
  const logs: string[] = [];
  const n = hydrateAgentRegistry(reg, { hydrateSubAgentTools: subAgentTools, log: (m) => logs.push(m) });
  assert.equal(n, 2);
  assert.deepEqual(reg.entries.map((e) => e.built.tools), [['ask_fallback_helper'], ['ask_marketing_helper']]);
  assert.match(logs[0] ?? '', /2 sub-agent tool registrations across 2 agent\(s\)/);
});

test('hydrateAgentRegistry: a rebuilt Agent is hydrated again', () => {
  const reg = fakeRegistry(['fallback']);
  hydrateAgentRegistry(reg, { hydrateSubAgentTools: subAgentTools, log: () => undefined });
  assert.deepEqual(reg.rebuild('fallback').tools, ['ask_fallback_helper']);
});

test('rebinder: a re-activation hydrates the LIVE registry, not the boot one', () => {
  const boot = fakeRegistry(['fallback']);
  let live = boot;
  const logs: string[] = [];
  const rebinder = createOrchestratorToolRebinder({ getRegistry: () => live, log: (m) => logs.push(m) });
  rebinder.setRegistryHydrator((reg) => {
    hydrateAgentRegistry(reg, { hydrateSubAgentTools: subAgentTools, log: () => undefined });
  });

  live = fakeRegistry(['fallback']);
  rebinder.rebind();

  assert.deepEqual(live.entries[0]?.built.tools, ['ask_fallback_helper']);
  assert.deepEqual(boot.entries[0]?.built.tools, []);
  assert.equal(logs.at(-1), 'orchestrator re-activated — agent tools re-bound (registry=yes)');
});

test('rebinder: without a registry (key-less boot) a rebind is a logged no-op', () => {
  const logs: string[] = [];
  const rebinder = createOrchestratorToolRebinder({ getRegistry: () => undefined, log: (m) => logs.push(m) });
  rebinder.setRegistryHydrator(() => assert.fail('nothing to hydrate'));
  rebinder.rebind();
  assert.equal(logs.at(-1), 'orchestrator re-activated — agent tools re-bound (registry=no)');
});
