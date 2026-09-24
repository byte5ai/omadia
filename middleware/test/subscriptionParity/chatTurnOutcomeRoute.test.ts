/**
 * OM-100b — what the chat routes record about the turn they just ran.
 *
 * The subtle half is the streaming route: neither runtime THROWS for a failed
 * turn. `CliChatAgent.chatStream` and `Orchestrator.chatStream` both report a
 * failure by yielding an `error` event and then completing normally, so a
 * handler that records success whenever the generator drains would have marked
 * every dead turn of the round-5 beta as a success — the exact false green
 * this signal exists to remove.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type {
  ChatAgent,
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
} from '@omadia/orchestrator';

import { createChatRouter } from '../../src/routes/chat.js';
import {
  getLastTurnOutcome,
  resetLastTurnOutcome,
} from '../../src/platform/lastTurnOutcome.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

const SLUG = 'general';

/** What the fake agent should do on the next turn. */
let behaviour: 'ok' | 'stream_error' | 'throw' = 'ok';

function scriptedChatAgent(): ChatAgent {
  return {
    chat: (_input: ChatTurnInput): Promise<ChatTurnResult> => {
      if (behaviour === 'throw') {
        return Promise.reject(new Error('CLI timed out after 600000ms without finishing'));
      }
      return Promise.resolve({ kind: 'message', text: 'ok' } as unknown as ChatTurnResult);
    },
    chatStream: async function* (): AsyncGenerator<ChatStreamEvent> {
      if (behaviour === 'throw') {
        throw new Error('transport died');
      }
      if (behaviour === 'stream_error') {
        yield {
          type: 'error',
          message: 'CLI timed out after 600000ms without finishing',
        } as unknown as ChatStreamEvent;
        return;
      }
      yield { type: 'text_delta', text: 'ok' } as unknown as ChatStreamEvent;
    },
  } as unknown as ChatAgent;
}

async function post(url: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hallo' }),
  });
  await res.text();
}

describe('OM-100b — chat routes record the turn outcome', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createChatRouter({
        resolveChatAgent: (slug) => (slug === SLUG ? scriptedChatAgent() : undefined),
        getDefaultSlug: () => SLUG,
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    resetLastTurnOutcome();
    behaviour = 'ok';
  });

  it('records success for a completed turn on both routes', async () => {
    await post(`${baseUrl}/chat`);
    assert.equal(getLastTurnOutcome()?.status, 'ok');

    resetLastTurnOutcome();
    await post(`${baseUrl}/chat/stream`);
    assert.equal(getLastTurnOutcome()?.status, 'ok');
  });

  it('records a streamed error event as a failure, with its class', async () => {
    behaviour = 'stream_error';
    await post(`${baseUrl}/chat/stream`);

    const outcome = getLastTurnOutcome();
    assert.equal(outcome?.status, 'failed');
    assert.equal(outcome?.errorCode, 'cli_timeout');
  });

  it('records a thrown turn as a failure on the non-streaming route', async () => {
    behaviour = 'throw';
    await post(`${baseUrl}/chat`);

    const outcome = getLastTurnOutcome();
    assert.equal(outcome?.status, 'failed');
    assert.equal(outcome?.errorCode, 'cli_timeout');
  });
});
