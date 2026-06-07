import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeWidenings,
  coveredByAny,
  extractPermissionSurface,
  extractSurfaceFromManifest,
  isSurfaceSubset,
  patternCovers,
  surfaceFromPartial,
} from '../../src/plugins/selfExtension/permissionSurface.js';
import type { Plugin } from '../../src/api/admin-v1.js';
import { applySpecPatches } from '../../src/plugins/builder/specPatcher.js';
import { baseSpec } from './_fixtures.js';

describe('extractPermissionSurface', () => {
  it('reduces the spec to its privilege dimensions', () => {
    const s = extractPermissionSurface(baseSpec());
    assert.deepEqual([...s.dependsOn], ['de.byte5.integration.dynamics']);
    assert.deepEqual([...s.graphReads], ['agent:dynamics:*']);
    assert.deepEqual([...s.graphWrites], ['agent:dynamics:*']);
    assert.deepEqual([...s.graphEntitySystems], ['sales-reports']);
    assert.deepEqual([...s.subAgentCalls], ['de.byte5.agent.helper']);
    assert.deepEqual([...s.llmModels], ['claude-haiku-4-5*']);
    assert.deepEqual([...s.networkOutbound], ['api.dynamics.com']);
    assert.equal(s.webScanner, false);
    assert.deepEqual([...s.externalReads], ['dynamics::*::query']);
    assert.equal(s.privacyClass, 'strict');
  });
});

describe('patternCovers / coveredByAny', () => {
  it('matches exact, `*`, and trailing-glob patterns', () => {
    assert.equal(patternCovers('a', 'a'), true);
    assert.equal(patternCovers('*', 'anything'), true);
    assert.equal(patternCovers('claude-haiku-4-5*', 'claude-haiku-4-5-20251001'), true);
    assert.equal(patternCovers('agent:x:*', 'agent:x:notes'), true);
    assert.equal(patternCovers('agent:x:*', 'agent:y:notes'), false);
    assert.equal(patternCovers('a', 'b'), false);
  });
  it('is conservative — a narrower grant does not cover a broader item', () => {
    assert.equal(coveredByAny('*', ['agent:x:*']), false);
    assert.equal(coveredByAny('claude-opus-4-8', ['claude-haiku-4-5*']), false);
  });
});

describe('computeWidenings — the non-escalation core', () => {
  const current = extractPermissionSurface(baseSpec());

  it('reports no widening when only a tool is added (no privilege change)', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'add', path: '/tools/-', value: { id: 'dynamics_aggregate', description: 'agg', input: {} } },
    ]);
    assert.deepEqual(computeWidenings(current, extractPermissionSurface(spec)), []);
    assert.equal(isSurfaceSubset(current, extractPermissionSurface(spec)), true);
  });

  it('flags a NEW graph write outside the current scope', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'add', path: '/permissions/graph/writes/-', value: 'odoo:invoices:*' },
    ]);
    const w = computeWidenings(current, extractPermissionSurface(spec));
    assert.equal(w.length, 1);
    assert.equal(w[0]?.dimension, 'graph.writes');
    assert.equal(w[0]?.item, 'odoo:invoices:*');
  });

  it('flags a new egress host, a new parent, and a new model', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'add', path: '/network/outbound/-', value: 'evil.example.com' },
      { op: 'add', path: '/depends_on/-', value: 'de.byte5.integration.odoo' },
      { op: 'add', path: '/permissions/llm/models_allowed/-', value: 'claude-opus-4-8' },
    ]);
    const dims = computeWidenings(current, extractPermissionSurface(spec)).map((x) => x.dimension);
    assert.deepEqual(dims.sort(), ['depends_on', 'llm.models_allowed', 'network.outbound']);
  });

  it('flags enabling web_scanner (egress guardrail relaxation)', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'add', path: '/network/web_scanner', value: true },
    ]);
    const w = computeWidenings(current, extractPermissionSurface(spec));
    assert.equal(w[0]?.dimension, 'network.web_scanner');
  });

  it('flags loosening privacy_class strict→default', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'replace', path: '/privacy_class', value: 'default' },
    ]);
    const w = computeWidenings(current, extractPermissionSurface(spec));
    assert.equal(w[0]?.dimension, 'privacy_class');
    assert.equal(w[0]?.item, 'strict→default');
  });

  it('does NOT flag tightening — removing grants is always allowed', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'remove', path: '/network/outbound/0' },
      { op: 'remove', path: '/permissions/graph/writes/0' },
    ]);
    assert.deepEqual(computeWidenings(current, extractPermissionSurface(spec)), []);
  });

  it('does NOT flag a model already covered by a current wildcard grant', () => {
    const { spec } = applySpecPatches(baseSpec(), [
      { op: 'add', path: '/permissions/llm/models_allowed/-', value: 'claude-haiku-4-5-20251001' },
    ]);
    assert.deepEqual(computeWidenings(current, extractPermissionSurface(spec)), []);
  });
});

function manifestPlugin(over: Partial<Plugin['permissions_summary']> = {}, top: Partial<Plugin> = {}): Plugin {
  return {
    depends_on: ['de.byte5.integration.dynamics'],
    privacy_class: 'strict',
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: ['agent:dynamics:*'],
      graph_writes: ['agent:dynamics:*'],
      network_outbound: ['api.dynamics.com'],
      ...over,
    },
    ...top,
  } as unknown as Plugin;
}

describe('extractSurfaceFromManifest — universal (standalone) path', () => {
  it('maps an installed manifest to the same surface dimensions as a spec', () => {
    const s = extractSurfaceFromManifest(manifestPlugin());
    assert.deepEqual([...s.dependsOn], ['de.byte5.integration.dynamics']);
    assert.deepEqual([...s.graphReads], ['agent:dynamics:*']);
    assert.deepEqual([...s.graphWrites], ['agent:dynamics:*']);
    assert.deepEqual([...s.networkOutbound], ['api.dynamics.com']);
    assert.equal(s.webScanner, false);
    assert.equal(s.privacyClass, 'strict');
    assert.deepEqual([...s.externalReads], []); // no manifest equivalent
  });

  it('reflects web_scanner + optional permission fields', () => {
    const s = extractSurfaceFromManifest(
      manifestPlugin({
        network_web_scanner: true,
        llm_models_allowed: ['claude-haiku-4-5*'],
        sub_agents_calls: ['de.byte5.agent.helper'],
        graph_entity_systems: ['sales-reports'],
      }),
    );
    assert.equal(s.webScanner, true);
    assert.deepEqual([...s.llmModels], ['claude-haiku-4-5*']);
    assert.deepEqual([...s.subAgentCalls], ['de.byte5.agent.helper']);
    assert.deepEqual([...s.graphEntitySystems], ['sales-reports']);
  });
});

describe('surfaceFromPartial — template `requires` check', () => {
  const manifest = extractSurfaceFromManifest(manifestPlugin());

  it('a template requiring only what the plugin holds is a subset (no escalation)', () => {
    const requires = surfaceFromPartial({ networkOutbound: ['api.dynamics.com'], graphReads: ['agent:dynamics:reports'] });
    assert.deepEqual(computeWidenings(manifest, requires), []);
  });

  it('a template requiring a new egress host or a graph write escalates', () => {
    const requires = surfaceFromPartial({ networkOutbound: ['evil.example.com'], graphWrites: ['odoo:invoices:*'] });
    const dims = computeWidenings(manifest, requires).map((w) => w.dimension).sort();
    assert.deepEqual(dims, ['graph.writes', 'network.outbound']);
  });

  it('defaults omitted dimensions to least-privilege', () => {
    const s = surfaceFromPartial({});
    assert.equal(s.webScanner, false);
    assert.equal(s.privacyClass, 'strict');
    assert.equal(s.networkOutbound.size, 0);
  });
});
