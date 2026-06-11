import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ChannelHandle,
  ChannelSessionClaims,
  ChannelSocket,
  ChatStreamEvent,
  CoreApi,
} from '../packages/harness-channel-sdk/src/index.js';
import type { PluginContext, ResolvedNotificationPayload } from '../packages/plugin-api/src/index.js';
import { handleCanvasSocket } from '../packages/omadia-ui-channel/src/canvasConnection.js';
import { activate } from '../packages/omadia-ui-channel/src/plugin.js';

/**
 * omadia-ui#15 — notifications are OUT-OF-BAND from the canvas surface
 * stream: the channel registers a NotificationRouter handler, maps the
 * middleware payload onto the wire `notification` message, and fans it out
 * to the target user's live sockets. The client acks dismissals.
 */

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
  close: () => void;
} {
  const sent: SentFrame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onClose: () => void = () => {};
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
    close: () => {
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
    close: () => {
      onClose();
    },
  };
}

function emptyStream(): AsyncIterable<ChatStreamEvent> {
  return (async function* () {
    await Promise.resolve();
  })();
}

function idMinter(): () => string {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

function completeHandshake(m: ReturnType<typeof makeSocket>): void {
  const offer = m.sent[0] as SentFrame;
  m.client({
    type: 'handshake_select',
    handshakeId: offer['handshakeId'],
    protocolVersion: '1.0',
    opsCatalogVersion: '1.0',
  });
}

describe('omadia-ui-channel — notification sink lifecycle (connection layer)', () => {
  it('registers the sink on handshake completion, disposes on close, forwards acks', () => {
    const sinks: Array<(msg: unknown) => void> = [];
    let disposed = 0;
    const acks: string[] = [];
    const m = makeSocket();
    handleCanvasSocket(m.socket, SESSION, {
      channelId: '@omadia/ui-channel',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      handleTurnStream: () => emptyStream(),
      mintId: idMinter(),
      registerNotificationSink: (subject, sink) => {
        assert.equal(subject, 'u1', 'sink keyed by the authenticated subject');
        sinks.push(sink);
        return () => {
          disposed += 1;
        };
      },
      onNotificationAck: (subject, id) => {
        acks.push(`${subject}:${id}`);
      },
    });
    assert.equal(sinks.length, 0, 'no sink before the handshake');
    completeHandshake(m);
    assert.equal(sinks.length, 1, 'sink registered once ready');

    sinks[0]?.({ type: 'notification', id: 'n-1', severity: 'info', title: 'Hi' });
    assert.ok(
      m.sent.some((f) => f.type === 'notification' && f['id'] === 'n-1'),
      'pushed notification reaches the wire',
    );

    m.client({ type: 'notification_ack', id: 'n-1' });
    m.client({ type: 'notification_ack', id: 42 }); // malformed → ignored
    assert.deepEqual(acks, ['u1:n-1']);

    m.close();
    assert.equal(disposed, 1, 'sink disposed on socket close');
  });
});

describe('omadia-ui-channel — NotificationRouter handler (plugin layer)', () => {
  async function activatePlugin(): Promise<{
    handle: ChannelHandle;
    dispatch: (p: ResolvedNotificationPayload) => void;
    wsHandler: (socket: ChannelSocket, session: ChannelSessionClaims) => void;
    channelDisposed: () => boolean;
  }> {
    let handler: ((p: ResolvedNotificationPayload) => void) | undefined;
    let wsHandler:
      | ((socket: ChannelSocket, session: ChannelSessionClaims) => void)
      | undefined;
    let channelDisposed = false;
    const ctx = {
      agentId: '@omadia/ui-channel',
      log: () => {},
      services: { get: () => undefined },
      notifications: {
        registerChannel: (_id: string, h: (p: ResolvedNotificationPayload) => void) => {
          handler = h;
          return () => {
            channelDisposed = true;
          };
        },
      },
    } as unknown as PluginContext;
    const core = {
      registerRoute: () => {},
      registerWebSocket: (
        _channelId: string,
        _path: string,
        h: (socket: ChannelSocket, session: ChannelSessionClaims) => void,
      ) => {
        wsHandler = h;
      },
      handleTurnStream: () => emptyStream(),
    } as unknown as CoreApi;
    const handle = await activate(ctx, core);
    assert.ok(handler, 'NotificationRouter handler registered on activate');
    assert.ok(wsHandler, 'canvas WS handler registered');
    return {
      handle,
      dispatch: handler,
      wsHandler,
      channelDisposed: () => channelDisposed,
    };
  }

  it('maps a payload onto the wire message and targets recipients by subject', async () => {
    const { handle, dispatch, wsHandler, channelDisposed } = await activatePlugin();

    const u1 = makeSocket();
    wsHandler(u1.socket, SESSION);
    completeHandshake(u1);
    const u2 = makeSocket();
    wsHandler(u2.socket, { ...SESSION, subject: 'u2' });
    completeHandshake(u2);

    dispatch({
      pluginId: '@omadia/plugin-plan-runner',
      title: 'Report fertig',
      body: 'Der Wochenreport liegt bereit.',
      recipients: ['u1'],
    });
    const n1 = u1.sent.find((f) => f.type === 'notification') as SentFrame;
    assert.ok(n1, 'targeted recipient receives the notification');
    assert.equal(n1['severity'], 'info');
    assert.equal(n1['title'], 'Report fertig');
    assert.equal(n1['source'], '@omadia/plugin-plan-runner');
    assert.ok(typeof n1['id'] === 'string' && (n1['id'] as string).length > 0);
    assert.ok(n1['dedupeKey'], 'dedupeKey set for coalescing');
    assert.equal(
      u2.sent.some((f) => f.type === 'notification'),
      false,
      'non-recipient gets nothing',
    );

    dispatch({
      pluginId: '@omadia/plugin-plan-runner',
      title: 'Broadcast',
      body: '',
      recipients: 'broadcast',
    });
    assert.ok(u2.sent.some((f) => f.type === 'notification'), 'broadcast reaches every user');

    await handle.close();
    assert.equal(channelDisposed(), true, 'router registration disposed on close');
  });
});
