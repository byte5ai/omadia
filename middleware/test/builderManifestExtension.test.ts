/**
 * US2 — verifies the Builder's manifest extension: `AgentSpecSchema` fills the
 * `multi_instance` / `privacy_class` defaults, the schema accepts explicit
 * values, and `manifestLinter.validateSpec` rejects an invalid declaration
 * (`multi_instance: false` without justification, or an unknown
 * `privacy_class`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentSpecSchema } from '../src/plugins/builder/agentSpec.js';
import { validateSpec } from '../src/plugins/builder/manifestLinter.js';
import type { AgentSpecSkeleton } from '../src/plugins/builder/types.js';

const baseSpec = (): Record<string, unknown> => ({
  template: 'agent-pure-llm',
  id: 'de.byte5.agent.test',
  name: 'Test',
  version: '0.1.0',
  description: 'Test agent',
  category: 'other',
  domain: 'test',
  depends_on: [],
  tools: [],
  skill: { role: 'helper' },
  setup_fields: [],
  jobs: [],
  playbook: { when_to_use: 'use it', not_for: [], example_prompts: [] },
  network: { outbound: [] },
  slots: {},
});

test('AgentSpecSchema fills multi_instance + privacy_class defaults', () => {
  const spec = AgentSpecSchema.parse(baseSpec());
  assert.equal(spec.multi_instance, true);
  assert.equal(spec.privacy_class, 'strict');
  assert.equal(spec.multi_instance_justification, undefined);
});

test('AgentSpecSchema accepts explicit multi_instance:false + justification', () => {
  const spec = AgentSpecSchema.parse({
    ...baseSpec(),
    multi_instance: false,
    multi_instance_justification: 'holds an exclusive hardware lock',
    privacy_class: 'default',
  });
  assert.equal(spec.multi_instance, false);
  assert.equal(
    spec.multi_instance_justification,
    'holds an exclusive hardware lock',
  );
  assert.equal(spec.privacy_class, 'default');
});

test('AgentSpecSchema rejects an unknown privacy_class at parse time', () => {
  assert.throws(() =>
    AgentSpecSchema.parse({ ...baseSpec(), privacy_class: 'open' }),
  );
});

test('manifestLinter rejects multi_instance:false without justification', () => {
  const skel = {
    ...baseSpec(),
    multi_instance: false,
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some(
      (v) => v.kind === 'multi_instance_justification_missing',
    ),
  );
});

test('manifestLinter rejects an invalid privacy_class on a raw skeleton', () => {
  const skel = {
    ...baseSpec(),
    privacy_class: 'open',
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'privacy_class_invalid'));
});

test('manifestLinter is silent on a valid multi_instance + privacy_class block', () => {
  const skel = {
    ...baseSpec(),
    multi_instance: true,
    privacy_class: 'strict',
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.ok(
    !result.violations.some(
      (v) =>
        v.kind === 'multi_instance_justification_missing' ||
        v.kind === 'privacy_class_invalid',
    ),
  );
});
