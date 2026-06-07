import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeWidenings,
  coveredByAny,
  extractPermissionSurface,
  isSurfaceSubset,
  patternCovers,
} from '../../src/plugins/selfExtension/permissionSurface.js';
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
