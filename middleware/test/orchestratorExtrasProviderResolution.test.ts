/**
 * OM-102 — the extras plugin's LLM-provider candidate chain.
 *
 * The bug this locks down: on a subscription-only install the operator assigns
 * a provider to the ORCHESTRATOR and never touches the background-scorer
 * plugin, so a chain that only ever looked at this plugin's own `llm_provider`
 * (defaulting to `anthropic`) left fact extraction, topic detection and the
 * scratch-promotion reaper off while a usable `claude-cli` sat right there.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider } from '@omadia/llm-provider';
import {
  buildProviderCandidates,
  resolveExtrasLlmProvider,
  type ProviderSource,
} from '@omadia/orchestrator-extras';

/** A provider stub — the chain only ever checks presence, never calls it. */
const fakeProvider = (id: string): LlmProvider =>
  ({ id }) as unknown as LlmProvider;

/** A source that can build exactly the ids it was given. */
function source(label: string, buildable: readonly string[]): ProviderSource {
  return {
    label,
    get: async (providerId: string) =>
      buildable.includes(providerId) ? fakeProvider(providerId) : undefined,
  };
}

describe('buildProviderCandidates', () => {
  it('falls back to anthropic alone when nothing is assigned', () => {
    assert.deepEqual(buildProviderCandidates({}), ['anthropic']);
  });

  it('inherits the orchestrator assignment when this plugin has none', () => {
    assert.deepEqual(
      buildProviderCandidates({ orchestrator: 'claude-cli' }),
      ['claude-cli', 'anthropic'],
    );
  });

  it('an explicit assignment on this plugin outranks the orchestrator', () => {
    assert.deepEqual(
      buildProviderCandidates({
        configured: 'openai',
        orchestrator: 'claude-cli',
      }),
      ['openai', 'claude-cli', 'anthropic'],
    );
  });

  it('ignores blank assignments and de-duplicates', () => {
    assert.deepEqual(
      buildProviderCandidates({ configured: '  ', orchestrator: 'anthropic' }),
      ['anthropic'],
    );
  });

  // The regression this guards: an existing install with a paid Anthropic key
  // on THIS plugin and an orchestrator on `claude-cli` must not silently move
  // three background jobs onto the operator's subscription quota.
  it('an own-scope Anthropic key outranks the inherited assignment', () => {
    assert.deepEqual(
      buildProviderCandidates({
        ownScopeAnthropic: true,
        orchestrator: 'claude-cli',
      }),
      ['anthropic', 'claude-cli'],
    );
  });

  it('an explicit assignment still beats the own-scope key', () => {
    assert.deepEqual(
      buildProviderCandidates({
        configured: 'openai',
        ownScopeAnthropic: true,
        orchestrator: 'claude-cli',
      }),
      ['openai', 'anthropic', 'claude-cli'],
    );
  });

  it('without an own key the orchestrator assignment is tried first', () => {
    assert.deepEqual(
      buildProviderCandidates({
        ownScopeAnthropic: false,
        orchestrator: 'claude-cli',
      }),
      ['claude-cli', 'anthropic'],
    );
  });

  it('trims whitespace around a configured id', () => {
    assert.deepEqual(buildProviderCandidates({ configured: ' claude-cli ' }), [
      'claude-cli',
      'anthropic',
    ]);
  });
});

describe('resolveExtrasLlmProvider', () => {
  it('resolves the subscription CLI when only the orchestrator is assigned', async () => {
    const resolved = await resolveExtrasLlmProvider({
      candidates: buildProviderCandidates({ orchestrator: 'claude-cli' }),
      sources: [source('kernel-pool', ['claude-cli'])],
    });
    assert.equal(resolved?.providerId, 'claude-cli');
    assert.equal(resolved?.source, 'kernel-pool');
  });

  it('prefers an Anthropic key in this plugin scope over nothing else', async () => {
    const resolved = await resolveExtrasLlmProvider({
      candidates: buildProviderCandidates({}),
      sources: [source('plugin-scope', ['anthropic'])],
    });
    assert.equal(resolved?.providerId, 'anthropic');
    assert.equal(resolved?.source, 'plugin-scope');
  });

  it('an earlier candidate wins even when a later one is buildable', async () => {
    const resolved = await resolveExtrasLlmProvider({
      candidates: ['claude-cli', 'anthropic'],
      sources: [source('kernel-pool', ['claude-cli', 'anthropic'])],
    });
    assert.equal(resolved?.providerId, 'claude-cli');
  });

  it('is candidate-major: the first candidate wins across ALL sources', async () => {
    // `claude-cli` is only buildable by the second source. A source-major loop
    // would hand back `anthropic` from the first source instead — which is
    // exactly the wrong answer when the operator assigned the CLI.
    const resolved = await resolveExtrasLlmProvider({
      candidates: ['claude-cli', 'anthropic'],
      sources: [
        source('plugin-scope', ['anthropic']),
        source('kernel-pool', ['claude-cli', 'anthropic']),
      ],
    });
    assert.equal(resolved?.providerId, 'claude-cli');
    assert.equal(resolved?.source, 'kernel-pool');
  });

  it('returns undefined when nothing in the chain can be built', async () => {
    const resolved = await resolveExtrasLlmProvider({
      candidates: buildProviderCandidates({}),
      sources: [source('plugin-scope', [])],
    });
    assert.equal(resolved, undefined);
  });

  it('skips a throwing source and keeps going', async () => {
    const logged: string[] = [];
    const exploding: ProviderSource = {
      label: 'plugin-scope',
      get: async () => {
        throw new Error('requires a baseURL');
      },
    };
    const resolved = await resolveExtrasLlmProvider({
      candidates: ['mistral', 'anthropic'],
      sources: [exploding, source('kernel-pool', ['anthropic'])],
      log: (m) => logged.push(m),
    });
    assert.equal(resolved?.providerId, 'anthropic');
    assert.ok(logged.some((m) => m.includes('requires a baseURL')));
  });
});
