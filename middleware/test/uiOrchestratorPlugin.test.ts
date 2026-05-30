import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CHAT_AGENT_SERVICE,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext } from '../packages/plugin-api/src/index.js';
import {
  activate,
  CANVAS_CHAT_AGENT_SERVICE,
} from '../packages/omadia-ui-orchestrator/src/plugin.js';

/**
 * PR-9a — the omadia-ui-orchestrator skeleton. activate() publishes
 * `canvasChatAgent` (bare key), delegating chat/chatStream to the base
 * `chatAgent` resolved lazily per call. No canvas composition yet.
 */

/** Tiny in-memory services registry + ctx mock (only the surface activate uses). */
function makeCtx() {
  const reg = new Map<string, unknown>();
  const ctx = {
    log: () => {},
    services: {
      get: <T>(name: string): T | undefined => reg.get(name) as T | undefined,
      provide: (name: string, impl: unknown) => {
        reg.set(name, impl);
        return () => reg.delete(name);
      },
    },
  } as unknown as PluginContext;
  return { ctx, reg };
}

const input = {
  userMessage: 'hi',
  sessionScope: 's',
  userId: 'u',
} as unknown as ChatTurnInput;

function baseBundle(events: ChatStreamEvent[]): ChatAgentBundle {
  return {
    agent: {
      chat: () => Promise.resolve({ text: 'base answer' }),
      async *chatStream() {
        await Promise.resolve();
        for (const e of events) yield e;
      },
    },
  };
}

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('omadia-ui-orchestrator skeleton', () => {
  it('publishes canvasChatAgent under the bare key', async () => {
    const { ctx, reg } = makeCtx();
    await activate(ctx);
    assert.equal(CANVAS_CHAT_AGENT_SERVICE, 'canvasChatAgent');
    const bundle = reg.get('canvasChatAgent') as ChatAgentBundle | undefined;
    assert.ok(bundle?.agent, 'canvasChatAgent bundle with an agent is registered');
  });

  it('delegates chat + chatStream to the base chatAgent', async () => {
    const { ctx, reg } = makeCtx();
    reg.set(CHAT_AGENT_SERVICE, baseBundle([{ type: 'done', answer: 'x', toolCalls: 0, iterations: 1 }]));
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    assert.equal((await agent.chat(input)).text, 'base answer');
    const events = await collect(agent.chatStream(input));
    assert.equal(events.at(-1)?.type, 'done');
  });

  it('degrades gracefully when no base chatAgent is registered', async () => {
    const { ctx, reg } = makeCtx();
    await activate(ctx);
    const agent = (reg.get('canvasChatAgent') as ChatAgentBundle).agent;
    await assert.rejects(() => agent.chat(input), /orchestrator unavailable/);
    const events = await collect(agent.chatStream(input));
    assert.deepEqual(events, [{ type: 'error', message: 'orchestrator unavailable' }]);
  });

  it('close() removes the published service', async () => {
    const { ctx, reg } = makeCtx();
    const handle = await activate(ctx);
    assert.ok(reg.get('canvasChatAgent'));
    await handle.close();
    assert.equal(reg.get('canvasChatAgent'), undefined);
  });
});
