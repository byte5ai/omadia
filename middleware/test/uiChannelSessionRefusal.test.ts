/**
 * Frames the kernel withheld from the canvas channel because it could not
 * check the session at that moment (the account lookup failed or timed out):
 * `ChannelSocket.onRefusedMessage`. Nothing in such a frame may run.
 *
 *   - a withheld `turn` or `canvas_refresh` never reaches the orchestrator and
 *     is answered with `turn_error`, so the client can retry as it would after
 *     an HTTP 503 instead of waiting for a turn that never starts;
 *   - a withheld `turn_abort` still stops the running turn: stopping work
 *     needs no authorisation;
 *   - a withheld `handshake_select` gets no ack: the socket closes with 1013
 *     (try again later), so the client reconnects through a fresh upgrade
 *     check, and no notification sink is registered;
 *   - withheld list reads and writes and notification acks touch nothing.
 *
 * The kernel side (which frames are withheld, and when) lives in
 * `channelSessionFrameGate.test.ts` and `webSocketRegistryFrameGate.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ChannelSessionClaims,
  ChannelSocket,
  ChatStreamEvent,
} from '../packages/harness-channel-sdk/src/index.js';
import {
  handleCanvasSocket,
  type CanvasConnectionDeps,
} from '../packages/omadia-ui-channel/src/canvasConnection.js';

const SESSION: ChannelSessionClaims = {
  subject: 'u1',
  email: 'u1@example.com',
  displayName: 'User One',
  provider: 'local',
};

const UNCHECKED = 'session check unavailable, try again';

interface SentFrame {
  type: string;
  [k: string]: unknown;
}

function makeSocket(): {
  socket: ChannelSocket;
  sent: SentFrame[];
  client: (m: unknown) => void;
  withheld: (m: unknown) => void;
  closed: () => { code?: number; reason?: string } | null;
} {
  const sent: SentFrame[] = [];
  let onMsg: (raw: string) => void = () => undefined;
  let onRefused: (raw: string) => void = () => undefined;
  let onClose: () => void = () => undefined;
  let closeInfo: { code?: number; reason?: string } | null = null;
  const socket: ChannelSocket = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as SentFrame);
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onRefusedMessage: (cb) => {
      onRefused = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: (code?: number, reason?: string) => {
      closeInfo = { code, reason };
      onClose();
    },
    request: { url: '/omadia-ui/canvas', headers: {} },
  };
  return {
    socket,
    sent,
    client: (m) => onMsg(JSON.stringify(m)),
    withheld: (m) => onRefused(JSON.stringify(m)),
    closed: () => closeInfo,
  };
}

function idMinter(): () => string {
  let n = 0;
  return () => `id-${String((n += 1))}`;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function emptyStream(): AsyncIterable<ChatStreamEvent> {
  return (async function* () {
    await Promise.resolve();
  })();
}

function deps(extra: Partial<CanvasConnectionDeps> = {}): CanvasConnectionDeps {
  return {
    channelId: '@omadia/ui-channel',
    protocolVersions: ['1.0'],
    opsCatalogVersions: ['1.0'],
    handleTurnStream: () => emptyStream(),
    mintId: idMinter(),
    ...extra,
  };
}

function selectMessage(m: ReturnType<typeof makeSocket>): Record<string, unknown> {
  const offer = m.sent[0] as SentFrame;
  return {
    type: 'handshake_select',
    handshakeId: offer.handshakeId,
    protocolVersion: '1.0',
    opsCatalogVersion: '1.0',
  };
}

describe('omadia-ui-channel — frames the kernel withheld (session not checked)', () => {
  it('a withheld turn never reaches the orchestrator and is answered with turn_error', async () => {
    const m = makeSocket();
    let calls = 0;
    handleCanvasSocket(
      m.socket,
      SESSION,
      deps({
        handleTurnStream: () => {
          calls += 1;
          return emptyStream();
        },
      }),
    );
    m.client(selectMessage(m));
    m.withheld({ type: 'turn', turnId: 't1', text: 'hello' });
    m.withheld({ type: 'canvas_refresh', turnId: 'r1', basedOnRevision: 'rev-1', currentTree: {} });
    m.withheld({ type: 'turn', text: 'without an id' });
    await flush();
    assert.equal(calls, 0, 'no orchestrator turn started');
    assert.deepEqual(m.sent.slice(2), [
      { type: 'turn_error', forTurn: 't1', message: UNCHECKED },
      { type: 'turn_error', forTurn: 'r1', message: UNCHECKED },
      { type: 'turn_error', message: UNCHECKED },
    ]);
    assert.equal(m.closed(), null, 'the socket stays open');
  });

  it('a withheld turn_abort still stops the running turn', async () => {
    const m = makeSocket();
    let unwound = 0;
    const hangingTurn = (): AsyncIterable<ChatStreamEvent> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<ChatStreamEvent>>(() => undefined),
        return: () => {
          unwound += 1;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    });
    handleCanvasSocket(m.socket, SESSION, deps({ handleTurnStream: hangingTurn }));
    m.client(selectMessage(m));
    m.client({ type: 'turn', turnId: 't1', text: 'slow' });
    await flush();

    m.withheld({ type: 'turn_abort', forTurn: 't1' });
    await flush();
    assert.equal(unwound, 1, 'the running orchestrator stream was unwound');
    assert.deepEqual(m.sent.at(-1), { type: 'turn_error', forTurn: 't1', message: 'aborted' });
  });

  it('a withheld handshake_select gets no ack: 1013, and no notification sink', () => {
    const m = makeSocket();
    let sinks = 0;
    handleCanvasSocket(
      m.socket,
      SESSION,
      deps({
        registerNotificationSink: () => {
          sinks += 1;
          return () => undefined;
        },
      }),
    );
    m.withheld(selectMessage(m));
    assert.deepEqual(m.closed(), { code: 1013, reason: 'session check unavailable' });
    assert.equal(m.sent.some((f) => f.type === 'handshake_ack'), false);
    assert.equal(sinks, 0);
  });

  it('withheld list reads and writes and notification acks touch nothing', async () => {
    const m = makeSocket();
    const touched: string[] = [];
    const registry = {
      load: (): Promise<never[]> => {
        touched.push('load');
        return Promise.resolve([]);
      },
      save: (): Promise<void> => {
        touched.push('save');
        return Promise.resolve();
      },
    };
    handleCanvasSocket(
      m.socket,
      SESSION,
      deps({
        canvasRegistry: registry,
        desktopRegistry: registry,
        onNotificationAck: () => touched.push('ack'),
      }),
    );
    m.client(selectMessage(m));
    m.withheld({ type: 'canvas_list_get' });
    m.withheld({ type: 'canvas_list_put', canvases: [{ sessionId: 'cs-1' }] });
    m.withheld({ type: 'desktop_list_get' });
    m.withheld({ type: 'desktop_list_put', desktops: [] });
    m.withheld({ type: 'notification_ack', id: 'n-1' });
    await flush();
    assert.deepEqual(touched, []);
    assert.deepEqual(
      m.sent.map((f) => f.type),
      ['handshake_offer', 'handshake_ack'],
    );
  });
});
