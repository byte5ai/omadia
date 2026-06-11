import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChannelSessionClaims, ChannelSocket, ChatStreamEvent } from '../packages/harness-channel-sdk/src/index.js';
import { handleCanvasSocket } from '../packages/omadia-ui-channel/src/canvasConnection.js';
import {
  sanitizeDesktopList,
  type DesktopListEntry,
} from '../packages/omadia-ui-channel/src/protocol.js';

/**
 * Multi-desktop workspaces (omadia-ui#14 follow-up): the per-user desktop
 * registry rides the authenticated canvas WS as desktop_list_get/put ↔
 * desktop_list, mirroring the canvas registry. Layouts are keyed by
 * canvasSessionId so they travel across installs.
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

function makeSocket(): { socket: ChannelSocket; sent: SentFrame[]; client: (m: unknown) => void } {
  const sent: SentFrame[] = [];
  let onMsg: (raw: string) => void = () => {};
  const socket: ChannelSocket = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as SentFrame);
    },
    onMessage: (cb: (data: string) => void) => {
      onMsg = cb;
    },
    onClose: () => {},
    close: () => {},
    request: { url: '/omadia-ui/canvas', headers: {} },
  };
  return { socket, sent, client: (m: unknown) => onMsg(JSON.stringify(m)) };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function emptyStream(): AsyncIterable<ChatStreamEvent> {
  return (async function* () {
    await Promise.resolve();
  })();
}

function readyConnection(registry?: {
  load(subject: string): Promise<DesktopListEntry[]>;
  save(subject: string, desktops: DesktopListEntry[]): Promise<void>;
}): ReturnType<typeof makeSocket> {
  const m = makeSocket();
  let n = 0;
  handleCanvasSocket(m.socket, SESSION, {
    channelId: '@omadia/ui-channel',
    protocolVersions: ['1.0'],
    opsCatalogVersions: ['1.0'],
    handleTurnStream: () => emptyStream(),
    mintId: () => `id-${(n += 1)}`,
    ...(registry ? { desktopRegistry: registry } : {}),
  });
  const offer = m.sent[0] as SentFrame;
  m.client({
    type: 'handshake_select',
    handshakeId: offer['handshakeId'],
    protocolVersion: '1.0',
    opsCatalogVersion: '1.0',
  });
  return m;
}

describe('omadia-ui-channel — per-user desktop registry (desktop_list)', () => {
  it('round-trips desktops subject-scoped and sanitises layouts/limits', async () => {
    const store = new Map<string, DesktopListEntry[]>();
    const registry = {
      load: (subject: string) => Promise.resolve(store.get(subject) ?? []),
      save: (subject: string, desktops: DesktopListEntry[]) => {
        store.set(subject, desktops);
        return Promise.resolve();
      },
    };
    const m = readyConnection(registry);

    m.client({
      type: 'desktop_list_put',
      desktops: [
        {
          desktopId: 'd1',
          name: 'Vertrieb',
          color: 2,
          updatedAt: 1000,
          layout: {
            kind: 'split',
            dir: 'columns',
            ratio: 0.01, // clamps to 0.15
            a: { kind: 'leaf', sessionId: 'cs-1' },
            b: { kind: 'leaf', sessionId: 'cs-2' },
          },
        },
        { desktopId: 'kaputt', name: 'no layout', color: 1, updatedAt: 1, layout: { kind: 'leaf' } },
        {
          desktopId: 'd2',
          name: 'Y'.repeat(99),
          color: 42,
          updatedAt: 2000,
          layout: {
            kind: 'split',
            dir: 'rows',
            ratio: 0.5,
            a: { kind: 'leaf', sessionId: 'cs-3' },
            b: { kind: 'leaf', sessionId: '' }, // invalid leaf → split collapses
          },
        },
      ],
    });
    await flush();
    const saved = store.get('u1');
    assert.ok(saved, 'registry keyed by the authenticated subject');
    assert.equal(saved.length, 2, 'entry without a sanitisable layout dropped');
    assert.equal((saved[0]?.layout as { ratio: number }).ratio, 0.15, 'ratio clamped');
    assert.equal(saved[1]?.name.length, 48, 'name clamped');
    assert.equal(saved[1]?.color, 5, 'color clamped');
    assert.deepEqual(saved[1]?.layout, { kind: 'leaf', sessionId: 'cs-3' }, 'invalid leaf collapses the split');

    m.client({ type: 'desktop_list_get' });
    await flush();
    const list = m.sent.find((f) => f.type === 'desktop_list');
    assert.ok(list, 'desktop_list answered');
    assert.deepEqual(
      (list.desktops as DesktopListEntry[]).map((d) => d.desktopId),
      ['d1', 'd2'],
    );
  });

  it('answers an empty list without a registry (wire-compatible degrade)', async () => {
    const m = readyConnection();
    m.client({ type: 'desktop_list_get' });
    await flush();
    const list = m.sent.find((f) => f.type === 'desktop_list');
    assert.ok(list);
    assert.deepEqual(list.desktops, []);
  });

  it('caps the list at 24 desktops', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      desktopId: `d${i}`,
      name: `D${i}`,
      color: 0,
      updatedAt: i,
      layout: { kind: 'leaf', sessionId: `cs-${i}` },
    }));
    assert.equal(sanitizeDesktopList(many).length, 24);
  });
});
