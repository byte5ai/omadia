/**
 * The canvas channel behind the kernel's per-frame session check, end to end:
 * `handleCanvasSocket` on a real `WebSocketRegistry`, driven by a real `ws`
 * client through the handshake.
 *
 *   - a session revoked on another replica (nothing announced here) never
 *     starts the next turn: the socket closes with 4403 and the orchestrator
 *     is not called;
 *   - while the account lookup fails, a turn is answered with `turn_error`
 *     instead of running, the socket stays open and answers pings, and the
 *     next turn after the outage runs normally.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/index.js';
import { handleCanvasSocket } from '../packages/omadia-ui-channel/src/canvasConnection.js';

import type { SessionAccount } from '../src/auth/sessionRevocation.js';
import {
  FAST,
  authCookie,
  closeClient,
  closeWithin,
  revocationGuard,
  startRegistryServer,
  type RegistryServer,
} from './_helpers/wsRegistryKit.js';

const BOUND_MS = 60;

interface Frame {
  type: string;
  [k: string]: unknown;
}

function account(sessionVersion = 0): SessionAccount {
  return { id: 'row-u1', status: 'active', sessionVersion };
}

/** The canvas channel on `/canvas`; `turns` counts orchestrator calls. */
function mountCanvas(rs: RegistryServer): { turns: () => number } {
  let turns = 0;
  let ids = 0;
  rs.registry.register('ch.canvas', '/canvas', (socket, session) => {
    handleCanvasSocket(socket, session, {
      channelId: 'ch.canvas',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: (): AsyncIterable<ChatStreamEvent> => {
        turns += 1;
        return (async function* () {
          await Promise.resolve();
          yield { type: 'text_delta', text: 'hi' } as ChatStreamEvent;
        })();
      },
      mintId: () => `id-${String((ids += 1))}`,
    });
  });
  return { turns: () => turns };
}

/** Collects every server frame; `next(type)` waits for the next of that type. */
function inbox(ws: WebSocket): { next: (type: string) => Promise<Frame> } {
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw: Buffer) => {
    frames.push(JSON.parse(raw.toString()) as Frame);
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    next: async (type) => {
      for (;;) {
        const i = frames.findIndex((f) => f.type === type);
        if (i !== -1) return frames.splice(i, 1)[0] as Frame;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

async function openCanvas(rs: RegistryServer): Promise<{
  ws: WebSocket;
  next: (type: string) => Promise<Frame>;
}> {
  const ws = new WebSocket(`${rs.base}/canvas`, {
    headers: { cookie: await authCookie({ sv: 0, uid: 'row-u1' }) },
  });
  ws.on('error', () => undefined);
  // Before 'open': the server's offer can arrive with the 101 itself, and
  // `ws` emits it before code awaiting 'open' resumes.
  const { next } = inbox(ws);
  await once(ws, 'open');
  const offer = await next('handshake_offer');
  ws.send(
    JSON.stringify({
      type: 'handshake_select',
      handshakeId: offer.handshakeId,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
    }),
  );
  await next('handshake_ack');
  return { ws, next };
}

describe('omadia-ui-channel behind the per-frame session check', () => {
  it('a session revoked on another replica never starts the next turn', FAST, async () => {
    const accounts = new Map([['local:u1', account()]]);
    const rs = await startRegistryServer({
      sessions: revocationGuard(accounts),
      channelFrameRecheckMs: BOUND_MS,
    });
    try {
      const canvas = mountCanvas(rs);
      const { ws } = await openCanvas(rs);

      accounts.set('local:u1', account(1)); // signed out elsewhere, not announced here
      await sleep(BOUND_MS * 2);
      const closed = closeWithin(ws, 3000);
      ws.send(JSON.stringify({ type: 'turn', turnId: 't1', text: 'act as me' }));
      const c = await closed;
      assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
      assert.equal(canvas.turns(), 0, 'the orchestrator never ran');
    } finally {
      await rs.close();
    }
  });

  it('during an outage a turn gets turn_error and the socket stays; afterwards turns run', FAST, async () => {
    const accounts = new Map([['local:u1', account()]]);
    let failing = false;
    const rs = await startRegistryServer({
      sessions: revocationGuard(accounts, { fail: () => failing }),
      channelFrameRecheckMs: BOUND_MS,
    });
    try {
      const canvas = mountCanvas(rs);
      const { ws, next } = await openCanvas(rs);

      failing = true;
      await sleep(BOUND_MS * 2);
      ws.send(JSON.stringify({ type: 'turn', turnId: 't1', text: 'during the outage' }));
      assert.deepEqual(await next('turn_error'), {
        type: 'turn_error',
        forTurn: 't1',
        message: 'session check unavailable, try again',
      });
      const pong = once(ws, 'pong');
      ws.ping();
      await pong;
      assert.equal(canvas.turns(), 0);

      failing = false;
      ws.send(JSON.stringify({ type: 'turn', turnId: 't2', text: 'after the outage' }));
      assert.deepEqual(await next('turn_complete'), { type: 'turn_complete', forTurn: 't2' });
      assert.equal(canvas.turns(), 1);
      await closeClient(ws);
    } finally {
      await rs.close();
    }
  });
});
