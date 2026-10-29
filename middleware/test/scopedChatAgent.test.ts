import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  createScopedChatAgent,
  NO_ORCHESTRATOR_MESSAGE,
  resolveScopedBundle,
} from '@omadia/orchestrator';
import type { ChatAgent } from '@omadia/channel-sdk';

/**
 * #1598 — the grant-less legacy `chatAgent@1` bundle answers only while there
 * is no orchestrator registry. With one, a turn without an orchestrator of its
 * own goes to the standard (fallback) orchestrator, or is refused.
 */

function agent(name: string, calls: string[]): ChatAgent {
  return {
    chat: async () => {
      calls.push(name);
      return { text: name } as never;
    },
    chatStream: async function* () {
      calls.push(name);
      yield { type: 'done', answer: name, toolCalls: 0, iterations: 1 } as never;
    },
    offeredToolNames: () => new Set([`${name}_tool`]),
  };
}

function registry(fallback: string | undefined, slugs: Record<string, ChatAgent>) {
  return {
    slugForFallback: () => fallback,
    get: (slug: string) => (slugs[slug] ? { built: { bundle: { agent: slugs[slug] } } } : undefined),
  };
}

describe('resolveScopedBundle', () => {
  const calls: string[] = [];
  const legacy = { agent: agent('legacy', calls) };
  const reg = registry('std', { std: agent('std', calls), hr: agent('hr', calls) });

  it('no registry → the legacy bundle (Postgres-less boot)', () => {
    assert.equal(resolveScopedBundle(undefined, legacy), legacy);
  });
  it('registry, no slug or "default" → the standard orchestrator', () => {
    assert.equal(resolveScopedBundle(reg, legacy)?.agent.offeredToolNames?.().has('std_tool'), true);
    assert.equal(resolveScopedBundle(reg, legacy, 'default')?.agent.offeredToolNames?.().has('std_tool'), true);
  });
  it('registry, a slug → that orchestrator', () => {
    assert.equal(resolveScopedBundle(reg, legacy, 'hr')?.agent.offeredToolNames?.().has('hr_tool'), true);
  });
  it('an unknown slug → undefined, never the legacy bundle', () => {
    assert.equal(resolveScopedBundle(reg, legacy, 'deleted'), undefined);
  });
  it('registry without a standard orchestrator → undefined', () => {
    assert.equal(resolveScopedBundle(registry(undefined, {}), legacy), undefined);
  });
});

describe('createScopedChatAgent (what chatAgent@1 publishes)', () => {
  it('delegates to the legacy agent while there is no registry', async () => {
    const calls: string[] = [];
    const scoped = createScopedChatAgent(agent('legacy', calls), () => undefined);
    await scoped.chat({ userMessage: 'hi' } as never);
    assert.deepEqual(calls, ['legacy']);
  });

  it('with a registry, runs the standard orchestrator — never the legacy one', async () => {
    const calls: string[] = [];
    const scoped = createScopedChatAgent(agent('legacy', calls), () =>
      registry('std', { std: agent('std', calls) }),
    );
    await scoped.chat({ userMessage: 'hi' } as never);
    for await (const _ of scoped.chatStream({ userMessage: 'hi' } as never)) void _;
    assert.deepEqual(calls, ['std', 'std']);
    assert.equal(scoped.offeredToolNames?.().has('legacy_tool'), false);
  });

  it('with a registry but no standard orchestrator, refuses the turn', async () => {
    const calls: string[] = [];
    const scoped = createScopedChatAgent(agent('legacy', calls), () => registry(undefined, {}));
    await assert.rejects(scoped.chat({ userMessage: 'hi' } as never), new RegExp(NO_ORCHESTRATOR_MESSAGE));
    const events: unknown[] = [];
    for await (const ev of scoped.chatStream({ userMessage: 'hi' } as never)) events.push(ev);
    assert.deepEqual(events, [{ type: 'error', message: NO_ORCHESTRATOR_MESSAGE }]);
    assert.deepEqual(calls, []);
  });
});
