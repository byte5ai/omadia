/**
 * PR-10b — the omadia-ui-channel canvas WebSocket transport.
 *
 * Drives `handleCanvasSocket` with a mock ChannelSocket + mock handleTurnStream
 * (no live socket — PR-11's WebSocketRegistry test owns the real-socket path):
 *   - server-initiated handshake_offer on connect;
 *   - handshake_select (matching versions) → handshake_ack with the resolved
 *     canvasSessionId (client-supplied id is honoured);
 *   - version mismatch → handshake_error, and a second mismatch closes;
 *   - after ack, a `turn` forms a well-shaped IncomingTurn and the orchestrator
 *     stream fans out — surface_* 1:1, text_delta → agent_text_delta, then
 *     turn_complete.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ChannelSessionClaims,
  ChannelSocket,
  ChatStreamEvent,
  IncomingTurn,
} from '../packages/harness-channel-sdk/src/index.js';
import { handleCanvasSocket } from '../packages/omadia-ui-channel/src/canvasConnection.js';

const SESSION: ChannelSessionClaims = {
  subject: 'u1',
  email: 'u1@example.com',
  displayName: 'User One',
  provider: 'local',
};

interface SentFrame {
  type: string;
  [k: string]: unknown;
}

function makeSocket(): {
  socket: ChannelSocket;
  sent: SentFrame[];
  client: (m: unknown) => void;
  closed: () => { code?: number; reason?: string } | null;
} {
  const sent: SentFrame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onClose: () => void = () => {};
  let closeInfo: { code?: number; reason?: string } | null = null;
  const socket: ChannelSocket = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as SentFrame);
    },
    onMessage: (cb: (data: string) => void) => {
      onMsg = cb;
    },
    onClose: (cb: () => void) => {
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
    client: (m: unknown) => {
      onMsg(JSON.stringify(m));
    },
    closed: () => closeInfo,
  };
}

/** Deterministic id minter: id-1, id-2, … */
function idMinter(): () => string {
  let n = 0;
  return () => `id-${(n += 1)}`;
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

describe('omadia-ui-channel canvas WebSocket — handshake', () => {
  it('sends a handshake_offer on connect', () => {
    const m = makeSocket();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => emptyStream(),
      mintId: idMinter(),
    });
    assert.equal(m.sent.length, 1);
    assert.equal(m.sent[0]?.type, 'handshake_offer');
    assert.deepEqual(m.sent[0]?.protocolVersions, ['1.0']);
    assert.deepEqual(m.sent[0]?.opsCatalogVersions, ['1.0']);
  });

  it('acks a matching select and honours a client-supplied canvasSessionId', () => {
    const m = makeSocket();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => emptyStream(),
      mintId: idMinter(),
    });
    const offer = m.sent[0] as SentFrame;
    m.client({
      type: 'handshake_select',
      handshakeId: offer.handshakeId,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      canvasSessionId: 'canvas-abc',
    });
    const ack = m.sent.find((f) => f.type === 'handshake_ack');
    assert.ok(ack, 'handshake_ack sent');
    assert.equal(ack?.canvasSessionId, 'canvas-abc');
  });

  it('rejects a version mismatch and closes after a second mismatch', () => {
    const m = makeSocket();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => emptyStream(),
      mintId: idMinter(),
    });
    const hid = (m.sent[0] as SentFrame).handshakeId as string;
    m.client({
      type: 'handshake_select',
      handshakeId: hid,
      protocolVersion: '9.9',
      opsCatalogVersion: '1.0',
    });
    const err = m.sent.find((f) => f.type === 'handshake_error');
    assert.ok(err, 'handshake_error sent');
    assert.equal(err?.reason, 'protocol-version-unsupported');
    assert.equal(m.closed(), null, 'not closed after first mismatch (downgrade chance)');
    // second mismatch → close
    m.client({
      type: 'handshake_select',
      handshakeId: hid,
      protocolVersion: '9.9',
      opsCatalogVersion: '1.0',
    });
    assert.ok(m.closed(), 'closed after the second mismatch');
  });

  it('accepts a valid select after a first version mismatch (downgrade)', () => {
    const m = makeSocket();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => emptyStream(),
      mintId: idMinter(),
    });
    const hid = (m.sent[0] as SentFrame).handshakeId as string;
    m.client({
      type: 'handshake_select',
      handshakeId: hid,
      protocolVersion: '9.9',
      opsCatalogVersion: '1.0',
    });
    assert.ok(m.sent.find((f) => f.type === 'handshake_error'), 'first mismatch errored');
    m.client({
      type: 'handshake_select',
      handshakeId: hid,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      canvasSessionId: 'cs1',
    });
    const ack = m.sent.find((f) => f.type === 'handshake_ack');
    assert.ok(ack, 'downgraded select acked');
    assert.equal(ack?.canvasSessionId, 'cs1');
    assert.equal(m.closed(), null, 'not closed');
  });

  it('ignores a select carrying a mismatched handshakeId', () => {
    const m = makeSocket();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => emptyStream(),
      mintId: idMinter(),
    });
    m.client({
      type: 'handshake_select',
      handshakeId: 'bogus',
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
    });
    assert.equal(m.sent.length, 1, 'only the offer — mismatched-handshakeId select ignored');
  });
});

describe('omadia-ui-channel canvas WebSocket — turn fan-out', () => {
  it('forms an IncomingTurn and fans out surface_* + text_delta + turn_complete', async () => {
    const m = makeSocket();
    let captured: IncomingTurn | undefined;
    const stream = (turn: IncomingTurn): AsyncIterable<ChatStreamEvent> => {
      captured = turn;
      return (async function* () {
        await Promise.resolve();
        yield {
          type: 'surface_snapshot',
          canvasSessionId: 'canvas-abc',
          surfaceSeq: 1,
          producesRevision: '1',
          tree: { type: 'p_text' },
          protocolVersion: '1.0',
          opsCatalogVersion: '1.0',
        } as unknown as ChatStreamEvent;
        yield { type: 'text_delta', text: 'hello' } as ChatStreamEvent;
      })();
    };

    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: stream,
      tenantId: 'acme',
      mintId: idMinter(),
    });
    const offer = m.sent[0] as SentFrame;
    m.client({
      type: 'handshake_select',
      handshakeId: offer.handshakeId,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      canvasSessionId: 'canvas-abc',
    });
    m.client({ type: 'turn', turnId: 't1', text: 'draw me a table' });
    await flush();
    await flush();

    // IncomingTurn shape
    assert.ok(captured, 'handleTurnStream was called');
    assert.equal(captured?.channelId, '@omadia/ui-channel');
    // conversationId is namespaced under the authenticated subject (cross-user
    // scope isolation); the raw client canvasSessionId stays in metadata.
    assert.equal(captured?.conversationId, 'u1::canvas-abc');
    assert.equal(
      (captured?.metadata as Record<string, unknown> | undefined)?.canvasSessionId,
      'canvas-abc',
    );
    assert.equal(captured?.text, 'draw me a table');
    assert.equal(captured?.tenantId, 'acme');
    assert.equal(captured?.userRef.kind, 'custom');
    assert.equal(captured?.userRef.id, 'u1');

    // fan-out
    const snapshot = m.sent.find((f) => f.type === 'surface_snapshot');
    assert.ok(snapshot, 'surface_snapshot forwarded 1:1');
    assert.equal(snapshot?.surfaceSeq, 1);
    const textDelta = m.sent.find((f) => f.type === 'agent_text_delta');
    assert.ok(textDelta, 'text_delta folded to agent_text_delta');
    assert.equal(textDelta?.forTurn, 't1');
    assert.equal(textDelta?.text, 'hello');
    const complete = m.sent.find((f) => f.type === 'turn_complete');
    assert.ok(complete, 'turn_complete sent');
    assert.equal(complete?.forTurn, 't1');
  });

  it('ignores a turn sent before the handshake completes', () => {
    const m = makeSocket();
    let called = false;
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => {
        called = true;
        return emptyStream();
      },
      mintId: idMinter(),
    });
    m.client({ type: 'turn', text: 'too early' });
    assert.equal(called, false, 'no turn dispatched before handshake_ack');
  });

  it('drops orchestrator telemetry (iteration/tool) from the canvas wire', async () => {
    const m = makeSocket();
    const stream = (): AsyncIterable<ChatStreamEvent> =>
      (async function* () {
        await Promise.resolve();
        yield { type: 'iteration_start', iteration: 1 } as ChatStreamEvent;
        yield {
          type: 'tool_use',
          id: 't',
          name: 'x',
          input: {},
        } as unknown as ChatStreamEvent;
        yield { type: 'text_delta', text: 'hi' } as ChatStreamEvent;
      })();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: stream,
      mintId: idMinter(),
    });
    const hid = (m.sent[0] as SentFrame).handshakeId as string;
    m.client({
      type: 'handshake_select',
      handshakeId: hid,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      canvasSessionId: 'c',
    });
    m.client({ type: 'turn', turnId: 't1', text: 'go' });
    await flush();
    await flush();
    const types = m.sent.map((f) => f.type);
    assert.ok(!types.includes('iteration_start'), 'iteration_start not forwarded');
    assert.ok(!types.includes('tool_use'), 'tool_use not forwarded');
    assert.ok(types.includes('agent_text_delta'), 'text forwarded');
    assert.ok(types.includes('turn_complete'), 'turn_complete sent');
  });

  it('rejects a turn with a malformed target (orchestrator not invoked)', () => {
    const m = makeSocket();
    let called = false;
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => {
        called = true;
        return emptyStream();
      },
      mintId: idMinter(),
    });
    const hid = (m.sent[0] as SentFrame).handshakeId as string;
    m.client({
      type: 'handshake_select',
      handshakeId: hid,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      canvasSessionId: 'c',
    });
    m.client({ type: 'turn', turnId: 't1', text: 'go', target: 'not-an-object' });
    const err = m.sent.find((f) => f.type === 'turn_error');
    assert.ok(err, 'turn_error for malformed target');
    assert.equal(called, false, 'orchestrator not invoked');
  });

  it('threads handshake localOperations and turn action into IncomingTurn.metadata', async () => {
    const m = makeSocket();
    let captured: IncomingTurn | undefined;
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: (turn) => {
        captured = turn;
        return emptyStream();
      },
      mintId: idMinter(),
    });
    const offer = m.sent[0] as SentFrame;
    m.client({
      type: 'handshake_select',
      handshakeId: offer.handshakeId,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      localOperations: ['brush', 'blur', 42], // non-strings are dropped
      canvasSessionId: 'c',
    });
    m.client({
      type: 'turn',
      turnId: 't1',
      text: '',
      action: { type: 'row-click', payload: { rowKey: 'anna' } },
    });
    await flush();

    assert.ok(captured, 'handleTurnStream was called');
    const metadata = captured?.metadata as Record<string, unknown> | undefined;
    assert.deepEqual(metadata?.localOperations, ['brush', 'blur']);
    assert.deepEqual(metadata?.action, { type: 'row-click', payload: { rowKey: 'anna' } });
  });

  it('omits localOperations from metadata when the client declared none, and rejects a malformed action', async () => {
    const m = makeSocket();
    let captured: IncomingTurn | undefined;
    let calls = 0;
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: (turn) => {
        captured = turn;
        calls += 1;
        return emptyStream();
      },
      mintId: idMinter(),
    });
    const offer = m.sent[0] as SentFrame;
    m.client({
      type: 'handshake_select',
      handshakeId: offer.handshakeId,
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
      canvasSessionId: 'c',
    });
    m.client({ type: 'turn', turnId: 't1', text: 'plain turn' });
    await flush();
    assert.equal(calls, 1);
    const metadata = captured?.metadata as Record<string, unknown> | undefined;
    assert.equal('localOperations' in (metadata ?? {}), false, 'no localOperations key when none declared');
    assert.equal('action' in (metadata ?? {}), false, 'no action key on a plain turn');

    m.client({ type: 'turn', turnId: 't2', text: 'go', action: 'not-an-object' });
    await flush();
    const err = m.sent.find((f) => f.type === 'turn_error' && f.forTurn === 't2');
    assert.ok(err, 'turn_error for malformed action');
    assert.equal(calls, 1, 'orchestrator not invoked for the malformed action');
  });
});
