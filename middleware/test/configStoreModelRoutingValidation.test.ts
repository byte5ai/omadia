/**
 * Validation guard on `model_routing` writes (issue #296).
 *
 * `setModelRouting` accepts a `{ mode, main, triage?, simple? }` JSON. Every
 * model id must resolve via `@omadia/llm-provider`; an unknown id would crash
 * every turn at runtime with `404 not_found_error`. The shape validator is a
 * pure function so we can test it without a Postgres pool.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  registerExternalModels,
  type ModelInfo,
} from '@omadia/llm-provider';

import {
  ConfigValidationError,
  validateModelRef,
  validateModelRoutingShape,
} from '../packages/harness-orchestrator/src/registry/configStore.js';

const OPUS: ModelInfo = {
  id: 'anthropic:claude-opus-4-8',
  provider: 'anthropic',
  modelId: 'claude-opus-4-8',
  label: 'Claude Opus 4.8',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 200000,
  vision: true,
  aliases: ['opus'],
};

const HAIKU: ModelInfo = {
  id: 'anthropic:claude-haiku-4-5',
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5',
  label: 'Claude Haiku 4.5',
  class: 'fast',
  maxTokens: 8192,
  contextWindow: 200000,
  vision: true,
  aliases: ['haiku'],
};

const SONNET: ModelInfo = {
  id: 'anthropic:claude-sonnet-4-6',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  label: 'Claude Sonnet 4.6',
  class: 'balanced',
  maxTokens: 16384,
  contextWindow: 200000,
  vision: true,
  aliases: ['sonnet'],
};

beforeEach(() => {
  clearExternalModels();
  registerExternalModels([OPUS, HAIKU, SONNET]);
});

test('accepts single mode with a registered model', () => {
  validateModelRoutingShape({ mode: 'single', main: 'claude-opus-4-8' });
  validateModelRoutingShape({ mode: 'single', main: 'anthropic:claude-opus-4-8' });
  validateModelRoutingShape({ mode: 'single', main: 'opus' }); // alias
});

test('accepts triage mode with registered classifier + simple', () => {
  validateModelRoutingShape({
    mode: 'triage',
    main: 'claude-opus-4-8',
    triage: 'claude-haiku-4-5',
    simple: 'claude-sonnet-4-6',
  });
});

test('triage mode tolerates omitted/empty triage + simple (run-time defaults)', () => {
  validateModelRoutingShape({ mode: 'triage', main: 'claude-opus-4-8' });
  validateModelRoutingShape({
    mode: 'triage',
    main: 'claude-opus-4-8',
    triage: '',
    simple: '',
  });
});

test('rejects unknown main model', () => {
  assert.throws(
    () => validateModelRoutingShape({ mode: 'single', main: 'made-up-model-9' }),
    (err) =>
      err instanceof ConfigValidationError &&
      /modelRouting\.main 'made-up-model-9'/.test(err.message),
  );
});

test('rejects unknown triage / simple in triage mode', () => {
  assert.throws(
    () =>
      validateModelRoutingShape({
        mode: 'triage',
        main: 'claude-opus-4-8',
        triage: 'no-such-classifier',
      }),
    (err) =>
      err instanceof ConfigValidationError &&
      /modelRouting\.triage 'no-such-classifier'/.test(err.message),
  );
  assert.throws(
    () =>
      validateModelRoutingShape({
        mode: 'triage',
        main: 'claude-opus-4-8',
        simple: 'no-such-simple',
      }),
    (err) =>
      err instanceof ConfigValidationError &&
      /modelRouting\.simple 'no-such-simple'/.test(err.message),
  );
});

test('rejects missing or empty main', () => {
  assert.throws(
    () => validateModelRoutingShape({ mode: 'single' } as Record<string, unknown>),
    (err) => err instanceof ConfigValidationError && /main is required/.test(err.message),
  );
  assert.throws(
    () => validateModelRoutingShape({ mode: 'single', main: '   ' }),
    (err) => err instanceof ConfigValidationError && /main is required/.test(err.message),
  );
});

test('rejects unknown mode', () => {
  assert.throws(
    () =>
      validateModelRoutingShape({
        mode: 'route-everything',
        main: 'claude-opus-4-8',
      }),
    (err) => err instanceof ConfigValidationError && /mode must be/.test(err.message),
  );
});

test('rejects non-string triage / simple', () => {
  assert.throws(
    () =>
      validateModelRoutingShape({
        mode: 'triage',
        main: 'claude-opus-4-8',
        triage: 42,
      }),
    (err) =>
      err instanceof ConfigValidationError && /triage must be a string/.test(err.message),
  );
});

// ── validateModelRef (sub-agent guard) ──────────────────────────────────

test('validateModelRef accepts a registered id (raw + alias + provider-qualified)', () => {
  validateModelRef('subAgent.model', 'claude-opus-4-8');
  validateModelRef('subAgent.model', 'opus');
  validateModelRef('subAgent.model', 'anthropic:claude-opus-4-8');
});

test('validateModelRef rejects an unknown id and tags the field', () => {
  assert.throws(
    () => validateModelRef('subAgent.model', 'no-such-model'),
    (err) =>
      err instanceof ConfigValidationError &&
      /subAgent\.model 'no-such-model'/.test(err.message),
  );
});

test('validateModelRef rejects empty / whitespace (callers should skip instead)', () => {
  assert.throws(
    () => validateModelRef('subAgent.model', ''),
    (err) =>
      err instanceof ConfigValidationError &&
      /must be a non-empty model ref/.test(err.message),
  );
  assert.throws(
    () => validateModelRef('subAgent.model', '   '),
    (err) =>
      err instanceof ConfigValidationError &&
      /must be a non-empty model ref/.test(err.message),
  );
});
