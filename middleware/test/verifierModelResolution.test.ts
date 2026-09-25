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
