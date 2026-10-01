/**
 * Channel WebSocket frames are authorised one at a time, not only at the
 * upgrade (real sockets, real registry). A frame reaches the handler only on
 * a session verdict whose check started at most `channelFrameRecheckMs`
 * (WS_SESSION_FRAME_RECHECK_MS, 5 s, in production) before the frame
 * arrived; with an older verdict `evaluateSessionToken` runs again first and
 * the frame waits for it. Revocation announcements are process-local, so this
 * is what carries a revocation made on another replica, or directly in SQL,
 * to an open socket — without waiting for the 60 s sweep.
 *
 *   - a revocation committed elsewhere (nothing announced here) closes the
 *     socket on its next frame (4403); that frame never reaches the handler,
 *     and neither do the frames that arrived while its check was running;
 *   - a revocation announced between the upgrade's check and the handshake
 *     closes the socket before the handler runs;
 *   - while the account lookup fails, or hangs past its deadline, no frame
 *     reaches `onMessage` (they go to `onRefusedMessage`), but the socket
 *     stays open and answers pings, and frames flow again once lookups work;
 *   - with a bound of 0 every frame gets its own check.
 *
 * The same rules on mocked timers: `channelSessionFrameGate.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import type { ChannelSocket } from '../packages/harness-channel-sdk/src/index.js';

import type { SessionAccount } from '../src/auth/sessionRevocation.js';
import {
  FAST,
  authCookie,
  closeClient,
  closeWithin,
  echo,
  openClient,
  revocationGuard,
  startRegistryServer,
  type RegistryServer,
} from './_helpers/wsRegistryKit.js';

/** The frame bound these tests run with: short, so "older" costs little time. */
const BOUND_MS = 60;

function account(id: string, sessionVersion = 0): SessionAccount {
  return { id, status: 'active', sessionVersion };
}

/**
 * Echoes every frame the kernel delivers and answers a withheld one with
 * `refused:<frame>`, so the client can tell the two apart.
 */
function gateHandler(seen: string[], refused: string[] = []): (socket: ChannelSocket) => void {
  return (socket) => {
    socket.onMessage((m) => {
      seen.push(m);
      socket.send(m);
    });
    socket.onRefusedMessage?.((m) => {
      refused.push(m);
      socket.send(`refused:${m}`);
    });
  };
}

async function withServer(
  deps: Parameters<typeof startRegistryServer>[0],
  run: (rs: RegistryServer) => Promise<void>,
): Promise<void> {
  const rs = await startRegistryServer(deps);
  try {
    await run(rs);
  } finally {
    await rs.close();
  }
}

/** Resolves once a pong arrives: the socket is open and the server answers. */
async function pingPong(ws: WebSocket): Promise<void> {
  const pong = once(ws, 'pong');
  ws.ping();
  await pong;
}

async function openAs(rs: RegistryServer, path: string): Promise<WebSocket> {
  return openClient(`${rs.base}${path}`, {
    cookie: await authCookie({ sv: 0, uid: 'row-u1' }),
  });
}

describe('WebSocketRegistry — a revocation elsewhere reaches the next frame', () => {
  it('closes the socket on its next frame (4403); that frame never reaches the handler', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    const sessions = revocationGuard(accounts);
    await withServer({ sessions, channelFrameRecheckMs: BOUND_MS }, async (rs) => {
      const seen: string[] = [];
      rs.registry.register('ch.next', '/next', gateHandler(seen));
      const ws = await openAs(rs, '/next');
      assert.equal(await echo(ws, 'before'), 'before');

      // Another replica signs u1 out: the row moves on and nothing is
      // announced here. The 60 s sweep is far away.
      accounts.set('local:u1', account('row-u1', 1));
      await sleep(BOUND_MS * 2);
      const closed = closeWithin(ws, 3000);
      ws.send('after');
      const c = await closed;
      assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
      assert.deepEqual(seen, ['before']);
    });
  });

  it('frames that arrive while that check runs are dropped with it', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let hold: Promise<void> | undefined;
    let release: () => void = () => undefined;
    let reading: () => void = () => undefined;
    const checkRunning = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const sessions = revocationGuard(accounts, {
      onLookup: async () => {
        if (!hold) return;
        reading();
        await hold;
      },
    });
    await withServer({ sessions, channelFrameRecheckMs: BOUND_MS }, async (rs) => {
      const seen: string[] = [];
      rs.registry.register('ch.held', '/held', gateHandler(seen));
      const ws = await openAs(rs, '/held');
      assert.equal(await echo(ws, 'before'), 'before');
      await sleep(BOUND_MS * 2);

      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const closed = closeWithin(ws, 3000);
      for (const frame of ['one', 'two', 'three']) ws.send(frame);
      await checkRunning;
      accounts.set('local:u1', account('row-u1', 1)); // revoked before the row is read
      release();
      const c = await closed;
      assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
      assert.deepEqual(seen, ['before'], 'no frame that waited on the check reached the handler');
    });
  });

  it('a revocation announced between the upgrade check and the handshake closes before the handler runs', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let signOutAfterRead = true;
    const sessions = revocationGuard(accounts, {
      // The upgrade's read found the row current; the user signs out on this
      // replica before the handshake completes, and the announcement finds
      // no socket to close yet.
      afterRead: () => {
        if (!signOutAfterRead) return;
        signOutAfterRead = false;
        accounts.set('local:u1', account('row-u1', 1));
        sessions.announce({ provider: 'local', sub: 'u1' });
      },
    });
    await withServer({ sessions }, async (rs) => {
      let ran = false;
      rs.registry.register('ch.race', '/race', () => {
        ran = true;
      });
      const ws = new WebSocket(`${rs.base}/race`, {
        headers: { cookie: await authCookie({ sv: 0, uid: 'row-u1' }) },
      });
      ws.on('error', () => undefined);
      const c = await closeWithin(ws, 3000);
      assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
      assert.equal(ran, false, 'the handler never sees a socket revoked during its upgrade');
    });
  });

  it('with a bound of 0 every frame gets its own check', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let lookups = 0;
    const sessions = revocationGuard(accounts, {
      onLookup: () => {
        lookups += 1;
      },
    });
    await withServer({ sessions, channelFrameRecheckMs: 0 }, async (rs) => {
      rs.registry.register('ch.zero', '/zero', gateHandler([]));
      const ws = await openAs(rs, '/zero');
      const afterUpgrade = lookups;
      for (const frame of ['a', 'b', 'c']) {
        // A verdict from the very millisecond a frame arrives still counts as
        // 0 ms old; space the frames so each one is past the last check.
        await sleep(5);
        assert.equal(await echo(ws, frame), frame);
      }
      assert.equal(lookups - afterUpgrade, 3);
      await closeClient(ws);
    });
  });
});

describe('WebSocketRegistry — no verdict, no frame', () => {
  it('while the account lookup fails, frames are withheld; the socket stays open and answers pings', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let failing = false;
    const sessions = revocationGuard(accounts, { fail: () => failing });
    await withServer({ sessions, channelFrameRecheckMs: BOUND_MS }, async (rs) => {
      const seen: string[] = [];
      const refused: string[] = [];
      rs.registry.register('ch.outage', '/outage', gateHandler(seen, refused));
      const ws = await openAs(rs, '/outage');
      assert.equal(await echo(ws, 'before'), 'before');

      failing = true;
      await sleep(BOUND_MS * 2);
      assert.equal(await echo(ws, 'turn'), 'refused:turn');
      await pingPong(ws);
      assert.equal(ws.readyState, WebSocket.OPEN);

      failing = false;
      assert.equal(await echo(ws, 'after'), 'after');
      assert.deepEqual(seen, ['before', 'after']);
      assert.deepEqual(refused, ['turn']);
      await closeClient(ws);
    });
  });

  it('a lookup that hangs is given up at its deadline: the frame is withheld, the socket stays', FAST, async () => {
    const DEADLINE_MS = 150;
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let hang = false;
    const sessions = revocationGuard(accounts, {
      onLookup: () => (hang ? new Promise<void>(() => undefined) : undefined),
    });
    await withServer(
      { sessions, channelFrameRecheckMs: BOUND_MS, channelSessionCheckTimeoutMs: DEADLINE_MS },
      async (rs) => {
        const seen: string[] = [];
        rs.registry.register('ch.hang', '/hang', gateHandler(seen));
        const ws = await openAs(rs, '/hang');
        assert.equal(await echo(ws, 'before'), 'before');

        hang = true;
        await sleep(BOUND_MS * 2);
        const sentAt = Date.now();
        assert.equal(await echo(ws, 'stuck'), 'refused:stuck');
        assert.ok(Date.now() - sentAt >= DEADLINE_MS - 5, 'held until the deadline');
        await pingPong(ws);

        hang = false;
        assert.equal(await echo(ws, 'after'), 'after');
        assert.deepEqual(seen, ['before', 'after']);
        await closeClient(ws);
      },
    );
  });
});
