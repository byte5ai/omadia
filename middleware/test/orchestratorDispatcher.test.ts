import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgentBundle, ChatStreamEvent } from '@omadia/channel-sdk';

import type { ChannelManifestBlock } from '../src/api/admin-v1.js';
import { createOrchestratorDispatcher } from '../src/channels/orchestratorDispatcher.js';

/**
 * PR-6 — the orchestrator dispatcher routes a turn to the channel's configured
 * `dispatch_service` (default `chatAgent`), fetches that bundle from the
 * registry, and streams its events. Classic channels (no `dispatch_service`)
 * must keep hitting `chatAgent`; the canvas channel routes to `canvasChatAgent`.
 */

function stubBundle(events: ChatStreamEvent[]): ChatAgentBundle {
  return {
    agent: {
      chat: () => Promise.resolve({ text: '' }),
      async *chatStream() {
        await Promise.resolve();
        for (const e of events) yield e;
      },
    },
  };
}

async function collect(
  it: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const turn = {
  scope: 'ch::conv',
  userRef: { kind: 'custom' as const, id: 'u1' },
  text: 'hi',
};

const canvasBlock: ChannelManifestBlock = {
  transport: { kind: 'websocket', routes: [], verify_signature: false },
  capabilities: ['text', 'canvas'],
  adapters: ['text'],
  dispatch_service: 'canvasChatAgent',
};

describe('createOrchestratorDispatcher', () => {
  it('routes a classic channel (no dispatch_service) to chatAgent', async () => {
    const asked: string[] = [];
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => undefined,
      getAgentBundle: (service) => {
        asked.push(service);
        return stubBundle([{ type: 'done', answer: 'ok', toolCalls: 0, iterations: 1 }]);
      },
    });
    const events = await collect(dispatcher.streamTurn({ ...turn, channelId: 'de.byte5.channel.teams' }));
    assert.deepEqual(asked, ['chatAgent']);
    assert.equal(events.at(-1)?.type, 'done');
  });

  it('routes a canvas channel to its declared dispatch_service', async () => {
    const asked: string[] = [];
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => canvasBlock,
      getAgentBundle: (service) => {
        asked.push(service);
        return stubBundle([{ type: 'text_delta', text: 'x' }]);
      },
    });
    const events = await collect(dispatcher.streamTurn({ ...turn, channelId: 'de.byte5.channel.omadia-ui' }));
    assert.deepEqual(asked, ['canvasChatAgent']);
    assert.equal(events[0]?.type, 'text_delta');
  });

  it('yields a single error event when no orchestrator is registered', async () => {
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => undefined,
      getAgentBundle: () => undefined,
    });
    const events = await collect(dispatcher.streamTurn({ ...turn, channelId: 'x' }));
    assert.deepEqual(events, [{ type: 'error', message: 'orchestrator unavailable' }]);
  });
});
