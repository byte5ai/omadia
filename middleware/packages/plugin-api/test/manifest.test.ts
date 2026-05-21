/**
 * US1 — verifies the `@omadia/plugin-api` manifest contract:
 * `validateManifest` accepts a well-formed manifest, rejects missing
 * required fields with a precise error, and enforces the conditional
 * `multiInstance: false ⇒ multiInstanceJustification` rule. Also
 * guards `validateManifest` against drift from its declarative twin,
 * `schemas/manifest.schema.json`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifest,
  loadManifestJsonSchema,
  type PluginManifest,
} from '../src/index.js';

const validManifest = (): PluginManifest => ({
  id: 'sample-plugin',
  name: 'Sample Plugin',
  version: '2.1.0',
  multiInstance: true,
  memoryNamespaces: ['sample'],
  requiredCapabilities: ['llm:chat'],
  privacyClass: 'default',
});

test('accepts a well-formed manifest', () => {
  const result = validateManifest(validManifest());
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('rejects a manifest missing a required field with a precise error', () => {
  const result = validateManifest({
    id: 'sample-plugin',
    name: 'Sample Plugin',
    // version omitted
    multiInstance: true,
    memoryNamespaces: [],
    requiredCapabilities: [],
    privacyClass: 'default',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'version'));
});

test('rejects a non-SemVer version', () => {
  const result = validateManifest({ ...validManifest(), version: 'v2' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'version'));
});

test('rejects an unknown privacyClass', () => {
  const result = validateManifest({ ...validManifest(), privacyClass: 'open' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'privacyClass'));
});

test('rejects non-string entries in memoryNamespaces', () => {
  const result = validateManifest({
    ...validManifest(),
    memoryNamespaces: ['ok', 42],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'memoryNamespaces'));
});

test('requires a justification when multiInstance is false', () => {
  const result = validateManifest({ ...validManifest(), multiInstance: false });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === 'multiInstanceJustification'));
});

test('accepts multiInstance:false with a non-empty justification', () => {
  const result = validateManifest({
    ...validManifest(),
    multiInstance: false,
    multiInstanceJustification: 'holds an exclusive hardware lock',
  });
  assert.equal(result.valid, true);
});

test('rejects a non-object manifest', () => {
  assert.equal(validateManifest(null).valid, false);
  assert.equal(validateManifest('manifest').valid, false);
  assert.equal(validateManifest([]).valid, false);
});

test('validateManifest stays in sync with manifest.schema.json', () => {
  const schema = loadManifestJsonSchema() as {
    required: string[];
    properties: Record<string, unknown>;
  };
  const expected = [
    'id',
    'name',
    'version',
    'multiInstance',
    'memoryNamespaces',
    'requiredCapabilities',
    'privacyClass',
  ];
  assert.deepEqual([...schema.required].sort(), [...expected].sort());
  for (const field of schema.required) {
    assert.ok(field in schema.properties, `${field} declared in schema properties`);
  }
});
