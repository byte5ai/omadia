/**
 * #1079 — dynamic sub-agents on the Anthropic host sent `class:frontier` RAW to
 * api.anthropic.com (404 on every call): the class ref was only resolved in the
 * non-Anthropic branch. `selectSubAgentHost` is the exact provider+model
 * selection `DynamicAgentRuntime.activate` runs, so these tests exercise the
 * production code path, not a copy.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnthropicClient } from '@omadia/llm-adapter-anthropic';
import { clearExternalModels, isClassRef, type LlmProvider } from '@omadia/llm-provider';

import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  selectSubAgentHost,
  type SubAgentHostDeps,
} from '../src/plugins/subAgentHostModel.js';
import { useBuiltinProviders } from './_helpers/builtinProviders.js';

useBuiltinProviders();

const fakeAnthropic = {} as unknown as AnthropicClient;

function fakeProvider(id: string): LlmProvider {
  return { id } as unknown as LlmProvider;
}

function deps(
  hostProviderId: string,
  overrides: Partial<SubAgentHostDeps> = {},
): SubAgentHostDeps {
  const serviceRegistry = new ServiceRegistry();
  serviceRegistry.provide('anthropicClient', fakeAnthropic);
  return {
    anthropic: fakeAnthropic,
    serviceRegistry,
    hostProviderId: () => hostProviderId,
    providerPool: { get: async (id: string) => fakeProvider(id) },
    ...overrides,
  };
}

const select = (
  hostProviderId: string,
  effectiveModel: string,
  overrides: Partial<SubAgentHostDeps> = {},
  modelSource: 'SUB_AGENT_MODEL' | 'manifest' = 'SUB_AGENT_MODEL',
) =>
  selectSubAgentHost(deps(hostProviderId, overrides), {
    agentId: '@test/agent',
    effectiveModel,
    modelSource,
  });

describe('#1079 — sub-agent host model selection', () => {
  it('anthropic host + default SUB_AGENT_MODEL (class:frontier) → a concrete opus id', async () => {
    const host = await select('anthropic', 'class:frontier');
    assert.equal(host.providerId, 'anthropic');
    assert.equal(host.model, 'claude-opus-5');
    assert.equal(isClassRef(host.model), false);
  });

  it('anthropic host + .env.example value (class:balanced) → the sonnet id', async () => {
    const host = await select('anthropic', 'class:balanced');
    assert.equal(host.model, 'claude-sonnet-5');
  });

  it('an unset host provider defaults to anthropic and still resolves', async () => {
    const host = await select('anthropic', 'class:frontier', {
      hostProviderId: undefined,
    });
    assert.equal(host.providerId, 'anthropic');
    assert.equal(host.model, 'claude-opus-5');
  });

  it('anthropic host keeps concrete ids and strips the provider prefix', async () => {
    assert.equal((await select('anthropic', 'claude-opus-4-7')).model, 'claude-opus-4-7');
    assert.equal((await select('anthropic', 'anthropic:claude-opus-5')).model, 'claude-opus-5');
  });

  it('openai host: class ref and a Claude id both map to the frontier model', async () => {
    const byClass = await select('openai', 'class:frontier');
    assert.equal(byClass.providerId, 'openai');
    assert.equal(byClass.model, 'gpt-5.5');
    assert.equal((byClass.provider as { id: string }).id, 'openai');
    assert.equal((await select('openai', 'claude-opus-5')).model, 'gpt-5.5');
  });

  it('claude-cli host: class:frontier → opus-cli (the runtime strips -cli)', async () => {
    const host = await select('claude-cli', 'class:frontier');
    assert.equal(host.model, 'opus-cli');
  });

  it('empty overlay on anthropic → the pinned seed instead of a raw class ref', async () => {
    clearExternalModels();
    const host = await select('anthropic', 'class:frontier');
    assert.equal(host.model, 'claude-opus-5');
  });

  it('unregistered provider with no pinned seed fails fast naming SUB_AGENT_MODEL', async () => {
    clearExternalModels();
    await assert.rejects(select('ghost', 'class:frontier'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /SUB_AGENT_MODEL/);
      assert.match(err.message, /@test\/agent/);
      assert.match(err.message, /ghost/);
      return true;
    });
  });

  it('a manifest-sourced ref names llm.prefers.model in the error', async () => {
    clearExternalModels();
    await assert.rejects(
      select('ghost', 'class:frontier', {}, 'manifest'),
      /llm\.prefers\.model/,
    );
  });

  it('a non-anthropic host with no key keeps the existing no-API-key error', async () => {
    await assert.rejects(
      select('mistral', 'class:frontier', {
        providerPool: undefined,
        hostGetSecret: undefined,
      }),
      /has no API key configured/,
    );
  });
});
