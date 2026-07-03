/**
 * Agent Builder P5 — persisted model_routing JSON → runtime mapping.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAgentModelRouting } from '../packages/harness-orchestrator/src/registry/agentRuntime.js';

test('null / malformed → empty (platform default)', () => {
  assert.deepEqual(resolveAgentModelRouting(null), {});
  assert.deepEqual(resolveAgentModelRouting(undefined), {});
  assert.deepEqual(resolveAgentModelRouting({ mode: 'triage' }), {}); // no main
});

test('single mode → model override, no routing', () => {
  const r = resolveAgentModelRouting({ mode: 'single', main: 'claude-opus-4-8' });
  assert.equal(r.model, 'claude-opus-4-8');
  assert.equal(r.modelRouting, undefined);
});

test('triage mode → runtime routing with classifier/simple/complex', () => {
  const r = resolveAgentModelRouting({
    mode: 'triage',
    main: 'claude-opus-4-8',
    triage: 'claude-haiku-4-5',
    simple: 'claude-sonnet-4-6',
  });
  assert.equal(r.model, 'claude-opus-4-8');
  assert.deepEqual(r.modelRouting, {
    classifierModel: 'claude-haiku-4-5',
    simpleModel: 'claude-sonnet-4-6',
    complexModel: 'claude-opus-4-8',
  });
});

test('triage without explicit simple defaults simple→main; missing triage→haiku', () => {
  const r = resolveAgentModelRouting({ mode: 'triage', main: 'claude-opus-4-8' });
  assert.deepEqual(r.modelRouting, {
    // DEFAULT_CLASSIFIER_MODEL is the dated, registry-served id (issue #296
    // nit) so the code's default agrees with its own write-validation.
    classifierModel: 'claude-haiku-4-5-20251001',
    simpleModel: 'claude-opus-4-8',
    complexModel: 'claude-opus-4-8',
  });
});
