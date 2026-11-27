/**
 * #1079 — `VERIFIER_MODEL` is resolved against the verifier's configured
 * `llm_provider` in `activate()`: a class ref becomes that provider's concrete
 * model, the Claude default its same-class model on another provider, and an
 * unresolvable class ref leaves `verifier@1` unpublished instead of sending the
 * ref raw to the vendor (opaque 404 on every verification).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearExternalModels } from '@omadia/llm-provider';
import type { PluginContext } from '@omadia/plugin-api';
import { activate } from '@omadia/verifier';

import { useBuiltinProviders } from './_helpers/builtinProviders.js';

useBuiltinProviders();

interface Harness {
  readonly ctx: PluginContext;
  readonly logs: string[];
  readonly provided: string[];
}

function harness(config: Record<string, string>): Harness {
  const logs: string[] = [];
  const provided: string[] = [];
  const ctx = {
    agentId: '@omadia/verifier',
    config: { get: (key: string) => config[key] },
    secrets: { get: async () => 'sk-test' },
    services: {
      get: (name: string) => (name === 'knowledgeGraph' ? {} : undefined),
      // No kernel pool: the verifier reads its own scope (legacy host path).
      getOptional: () => undefined,
      provide: (name: string) => {
        provided.push(name);
        return () => {};
      },
    },
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    },
  } as unknown as PluginContext;
  return { ctx, logs, provided };
}

const publishedModel = (logs: readonly string[]): string | undefined =>
  logs
    .map((line) => /verifier@1 published .*model=([^,]+),/.exec(line)?.[1])
    .find((m) => m !== undefined);

describe('#1079 — verifier model resolution', () => {
  it('class:fast on anthropic → the concrete haiku id', async () => {
    const h = harness({
      verifier_enabled: 'true',
      llm_provider: 'anthropic',
      verifier_model: 'class:fast',
    });
    await activate(h.ctx);
    assert.deepEqual(h.provided, ['verifier']);
    assert.equal(publishedModel(h.logs), 'claude-haiku-4-5-20251001');
  });

  it('the Claude default on openai → its same-class model, not the raw Claude id', async () => {
    const h = harness({ verifier_enabled: 'true', llm_provider: 'openai' });
    await activate(h.ctx);
    assert.deepEqual(h.provided, ['verifier']);
    assert.equal(publishedModel(h.logs), 'gpt-5.4-mini');
  });

  it('an unresolvable class ref leaves verifier@1 unpublished, naming VERIFIER_MODEL', async () => {
    clearExternalModels();
    const h = harness({
      verifier_enabled: 'true',
      llm_provider: 'anthropic',
      verifier_model: 'class:frontier',
    });
    await activate(h.ctx);
    assert.deepEqual(h.provided, []);
    assert.ok(
      h.logs.some(
        (l) => /VERIFIER_MODEL/.test(l) && /NOT published/.test(l),
      ),
      h.logs.join('\n'),
    );
  });
});

describe('#2240 — the verifier builds its provider from the kernel pool', () => {
  function withPool(config: Record<string, string>, serves: readonly string[]) {
    const asked: string[] = [];
    const h = harness(config);
    const services = h.ctx.services as unknown as Record<string, unknown>;
    services['getOptional'] = (name: string) =>
      name === 'llmProviderPool'
        ? {
            get: async (id: string) => {
              asked.push(id);
              return serves.includes(id)
                ? { id, capabilities: {}, complete: async () => ({}) }
                : undefined;
            },
          }
        : undefined;
    // The plugin's own scope holds nothing: the pool is the only source.
    (h.ctx as unknown as { secrets: { get: () => Promise<undefined> } }).secrets = {
      get: async () => undefined,
    };
    return { h, asked };
  }

  it('publishes verifier@1 on a provider only the kernel pool can build', async () => {
    const { h, asked } = withPool({ verifier_enabled: 'true', llm_provider: 'anthropic' }, ['anthropic']);
    await activate(h.ctx);
    assert.deepEqual(asked, ['anthropic']);
    assert.deepEqual(h.provided, ['verifier']);
  });

  it('refuses claude-cli even when the pool could build it', async () => {
    const { h, asked } = withPool({ verifier_enabled: 'true', llm_provider: 'claude-cli' }, ['claude-cli']);
    await activate(h.ctx);
    assert.deepEqual(asked, []);
    assert.deepEqual(h.provided, []);
  });
});
