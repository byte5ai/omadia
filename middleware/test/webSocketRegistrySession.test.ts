/**
 * Channel WebSocket session lifetime: a socket stays authorised exactly as
 * long as the session that opened it, and no longer.
 *
 *   - the handler gets claims with `expiresAt` (the token's `exp`), never the
 *     raw token: the session cookie is stripped from `socket.request.headers`;
 *   - at `exp` the kernel closes the socket with 4401 "session expired"; a
 *     token without `exp`, or one that expired while the upgrade was being
 *     checked, is closed with 4401 before the handler runs;
 *   - a revocation announced on this replica closes that user's sockets at
 *     once (4403), and `closeSessions(match)` closes a principal's sockets on
 *     demand; frames that arrive after that never reach the handler;
 *   - the periodic re-check through `evaluateSessionToken` closes an idle
 *     socket whose account moved its session version on or whose Entra
 *     identity left the whitelist (4403) and keeps a valid socket open; while
 *     the account cannot be read, frames are withheld but the socket stays
 *     (the per-frame check across replicas: `webSocketRegistryFrameGate.test.ts`);
 *   - a close by the client or by `deactivateChannel` (1001) stops the
 *     socket's expiry timer and its re-checks.
 *
 * Deterministic timer edges (exactly-at-exp, late timers, the setTimeout
 * ceiling) live in `channelSessionTracker.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { SignJWT } from 'jose';
import { WebSocket } from 'ws';

import type {
  ChannelSessionClaims,
  ChannelSocket,
} from '../packages/harness-channel-sdk/src/index.js';

import { SESSION_COOKIE } from '../src/auth/requireAuth.js';
import { verifySession } from '../src/auth/sessionJwt.js';
import type { SessionAccount } from '../src/auth/sessionRevocation.js';
import {
  WS_CLOSE_SESSION_EXPIRED,
  WS_CLOSE_SESSION_FORBIDDEN,
  WS_SESSION_RECHECK_MS,
} from '../src/channels/webSocketRegistry.js';
import {
  FAST,
  KEY,
  MutableWhitelist,
  authCookie,
  closeClient,
  closeWithin,
  echo,
  entraCookie,
  openClient,
  revocationGuard,
  startRegistryServer,
  tokenOf,
  watchUncaught,
  type RegistryServer,
} from './_helpers/wsRegistryKit.js';

const SLOW = { timeout: 15_000 } as const;

/** Echo handler that records every frame it was handed. */
function echoHandler(seen: string[] = []): (socket: ChannelSocket) => void {
  return (socket) => {
    socket.onMessage((m) => {
      seen.push(m);
      socket.send(m);
    });
  };
}

function account(id: string, sessionVersion = 0): SessionAccount {
  return { id, status: 'active', sessionVersion };
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

describe('WebSocketRegistry — what a channel handler is handed', () => {
  it('claims carry expiresAt (the token exp) and no token; the session cookie is stripped', FAST, async () => {
    await withServer({}, async (rs) => {
      const cookie = await authCookie();
      const token = tokenOf(cookie);
      const { exp } = await verifySession(token, KEY);
      let claims: ChannelSessionClaims | undefined;
      let headers: Record<string, string | string[] | undefined> | undefined;
      rs.registry.register('ch.claims', '/claims', (socket, session) => {
        claims = session;
        headers = socket.request.headers;
        echoHandler()(socket);
      });

      const ws = await openClient(`${rs.base}/claims`, {
        cookie: `theme=dark; ${cookie}; lang=de`,
      });
      assert.equal(await echo(ws, 'ping'), 'ping');

      assert.equal(claims?.subject, 'u1');
      assert.equal(claims?.expiresAt, exp);
      assert.equal(JSON.stringify(claims).includes(token), false, 'claims never carry the token');
      assert.equal(headers?.cookie, 'theme=dark; lang=de', 'other cookies pass through');
      assert.equal(JSON.stringify(headers).includes(token), false, 'no header carries the token');
      await closeClient(ws);
    });
  });

  it('the re-check cadence defaults to 60 s, the same as the UI session heartbeat', () => {
    assert.equal(WS_SESSION_RECHECK_MS, 60_000);
    assert.equal(WS_CLOSE_SESSION_EXPIRED, 4401);
    assert.equal(WS_CLOSE_SESSION_FORBIDDEN, 4403);
  });
});

describe('WebSocketRegistry — a channel socket ends with its session', () => {
  it('closes with 4401 "session expired" when the token expires, and the handler hears it', SLOW, async () => {
    await withServer({}, async (rs) => {
      const cookie = await authCookie({ expiresIn: '2s' });
      const { exp } = await verifySession(tokenOf(cookie), KEY);
      let handlerSawClose = false;
      rs.registry.register('ch.exp', '/exp', (socket) => {
        echoHandler()(socket);
        socket.onClose(() => {
          handlerSawClose = true;
        });
      });

      const ws = await openClient(`${rs.base}/exp`, { cookie });
      assert.equal(await echo(ws, 'still valid'), 'still valid');
      const closed = await closeWithin(ws, exp * 1000 - Date.now() + 3000);
      assert.deepEqual([closed.code, closed.reason], [4401, 'session expired']);
      assert.ok(closed.at >= exp * 1000, 'never before exp');
      assert.equal(handlerSawClose, true);
    });
  });

  it('closes a token without exp with 4401 before the handler runs', FAST, async () => {
    await withServer({}, async (rs) => {
      let ran = false;
      rs.registry.register('ch.noexp', '/noexp', () => {
        ran = true;
      });
      const token = await new SignJWT({
        sub: 'u1',
        email: 'u1@example.com',
        display_name: 'User One',
        provider: 'local',
        role: 'admin',
      })
        .setProtectedHeader({ alg: 'HS512' })
        .setIssuer('omadia')
        .setIssuedAt()
        .sign(KEY);

      const ws = await openClient(`${rs.base}/noexp`, { cookie: `${SESSION_COOKIE}=${token}` });
      const closed = await closeWithin(ws, 3000);
      assert.deepEqual([closed.code, closed.reason], [4401, 'session expired']);
      assert.equal(ran, false, 'the handler must not run for a session without an expiry');
    });
  });

  it('closes with 4401 before the handler runs when the token expires during the upgrade check', SLOW, async () => {
    // 2–3 s of headroom, so the signature check at the upgrade is never the
    // step that sees the expiry, even on a loaded runner.
    const expSec = Math.floor(Date.now() / 1000) + 3;
    const accounts = new Map([['local:u1', account('row-u1')]]);
    // The account read is the upgrade check's last step; it answers only
    // once the token is past its exp, so the handshake completes on a dead
    // session.
    const sessions = revocationGuard(accounts, {
      onLookup: async () => {
        const wait = expSec * 1000 - Date.now() + 50;
        if (wait > 0) await sleep(wait);
      },
    });
    await withServer({ sessions }, async (rs) => {
      let ran = false;
      rs.registry.register('ch.late', '/late', () => {
        ran = true;
      });
      const ws = new WebSocket(`${rs.base}/late`, {
        headers: { cookie: await authCookie({ sv: 0, uid: 'row-u1', expiresIn: expSec }) },
      });
      ws.on('error', () => undefined);
      const closed = await closeWithin(ws, 6000);
      assert.deepEqual([closed.code, closed.reason], [4401, 'session expired']);
      assert.equal(ran, false, 'the handler must not run for an already expired session');
    });
  });

  it('keeps a valid socket open across re-checks; an outage withholds frames but keeps the socket', SLOW, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let failing = false;
    let lookups = 0;
    const sessions = revocationGuard(accounts, {
      fail: () => failing,
      onLookup: () => {
        lookups += 1;
      },
    });
    await withServer({ sessions, channelSessionRecheckMs: 25 }, async (rs) => {
      const seen: string[] = [];
      rs.registry.register('ch.valid', '/valid', echoHandler(seen));
      const ws = await openClient(`${rs.base}/valid`, {
        cookie: await authCookie({ sv: 0, uid: 'row-u1' }),
      });
      const afterUpgrade = lookups;
      await sleep(250);
      assert.ok(lookups - afterUpgrade >= 3, `re-checks ran (${String(lookups - afterUpgrade)})`);
      assert.equal(await echo(ws, 'still here'), 'still here');

      failing = true;
      try {
        await sleep(250);
        // The sweep could not check the session, so no verdict stands: the
        // frame is withheld (like HTTP's 503), and the socket is not closed.
        ws.send('during the outage');
        await sleep(150);
        assert.equal(ws.readyState, WebSocket.OPEN, 'an outage is not a verdict');
      } finally {
        failing = false;
      }
      // The next reply is this frame's: the withheld one was never handled.
      assert.equal(await echo(ws, 'after the outage'), 'after the outage');
      assert.deepEqual(seen, ['still here', 'after the outage']);
      await closeClient(ws);
    });
  });
});

describe('WebSocketRegistry — revocation closes live sockets', () => {
  it('closeSessions(match) closes only the matching principal with 4403 and returns the count', FAST, async () => {
    await withServer({}, async (rs) => {
      rs.registry.register('ch.a', '/a', echoHandler());
      rs.registry.register('ch.b', '/b', echoHandler());
      const u1 = await authCookie();
      const u2 = await authCookie({ sub: 'u2', email: 'u2@example.com' });
      const a1 = await openClient(`${rs.base}/a`, { cookie: u1 });
      const b1 = await openClient(`${rs.base}/b`, { cookie: u1 });
      const a2 = await openClient(`${rs.base}/a`, { cookie: u2 });

      const closedA1 = closeWithin(a1, 3000);
      const closedB1 = closeWithin(b1, 3000);
      const closed = rs.registry.closeSessions((p) => p.provider === 'local' && p.subject === 'u1');
      assert.equal(closed, 2);
      for (const c of await Promise.all([closedA1, closedB1])) {
        assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
      }
      assert.equal(await echo(a2, 'u2 unaffected'), 'u2 unaffected');
      assert.equal(rs.registry.closeSessions((p) => p.subject === 'u1'), 0, 'nothing left to close');
      await closeClient(a2);
    });
  });

  it('closeSessions counts only sockets it actually closed (a closing socket is skipped)', FAST, async () => {
    await withServer({}, async (rs) => {
      let counted: number | undefined;
      rs.registry.register('ch.bye', '/bye', (socket) => {
        socket.onMessage(() => {
          socket.close(1000, 'handler done');
          counted = rs.registry.closeSessions(() => true);
        });
      });
      const ws = await openClient(`${rs.base}/bye`, { cookie: await authCookie() });
      const closed = closeWithin(ws, 3000);
      ws.send('bye');
      assert.equal((await closed).code, 1000, 'the handler close stands');
      assert.equal(counted, 0);
    });
  });

  it('a frame that arrives after the session was closed never reaches the handler', FAST, async () => {
    await withServer({}, async (rs) => {
      const seen: string[] = [];
      rs.registry.register('ch.late-frame', '/late-frame', echoHandler(seen));
      const ws = await openClient(`${rs.base}/late-frame`, { cookie: await authCookie() });
      assert.equal(await echo(ws, 'before'), 'before');

      const closed = closeWithin(ws, 3000);
      // Written now, read by the server only after the revocation below has
      // run (same event loop): the frame lands on a closing socket.
      ws.send('after');
      assert.equal(rs.registry.closeSessions(() => true), 1);
      assert.equal((await closed).code, 4403);
      assert.deepEqual(seen, ['before']);
    });
  });

  it('a revocation announced on this replica closes that user\'s sockets at once (4403)', FAST, async () => {
    const accounts = new Map([
      ['local:u1', account('row-u1')],
      ['local:u2', account('row-u2')],
    ]);
    const sessions = revocationGuard(accounts);
    await withServer({ sessions }, async (rs) => {
      rs.registry.register('ch.announce', '/announce', echoHandler());
      const mine = await openClient(`${rs.base}/announce`, {
        cookie: await authCookie({ sv: 0, uid: 'row-u1' }),
      });
      const theirs = await openClient(`${rs.base}/announce`, {
        cookie: await authCookie({ sub: 'u2', email: 'u2@example.com', sv: 0, uid: 'row-u2' }),
      });

      const closed = closeWithin(mine, 2000);
      // What a revoking route does: move the version, then announce it.
      accounts.set('local:u1', account('row-u1', 1));
      sessions.announce({ provider: 'local', sub: 'u1' });
      const c = await closed;
      assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
      assert.equal(await echo(theirs, 'unaffected'), 'unaffected');
      await closeClient(theirs);
    });
  });

  it('the periodic re-check closes a socket revoked on another replica (no announcement)', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    const sessions = revocationGuard(accounts);
    await withServer({ sessions, channelSessionRecheckMs: 50 }, async (rs) => {
      rs.registry.register('ch.replica', '/replica', echoHandler());
      const ws = await openClient(`${rs.base}/replica`, {
        cookie: await authCookie({ sv: 0, uid: 'row-u1' }),
      });
      await sleep(150);
      assert.equal(await echo(ws, 'valid so far'), 'valid so far');

      accounts.set('local:u1', account('row-u1', 1));
      const c = await closeWithin(ws, 3000);
      assert.deepEqual([c.code, c.reason], [4403, 'session revoked']);
    });
  });

  it('the periodic re-check closes an Entra session that left the whitelist (4403)', FAST, async () => {
    const whitelist = new MutableWhitelist('allowed@example.com');
    await withServer({ whitelist, channelSessionRecheckMs: 50 }, async (rs) => {
      rs.registry.register('ch.wl', '/wl', echoHandler());
      const ws = await openClient(`${rs.base}/wl`, {
        cookie: await entraCookie('allowed@example.com'),
      });
      assert.equal(await echo(ws, 'allowed'), 'allowed');

      whitelist.withdraw('allowed@example.com');
      const c = await closeWithin(ws, 3000);
      assert.deepEqual([c.code, c.reason], [4403, 'session forbidden']);
    });
  });
});

describe('WebSocketRegistry — a closed socket leaves nothing running', () => {
  it('a client close stops the expiry timer and the re-checks; the handler hears one close', SLOW, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let lookups = 0;
    const sessions = revocationGuard(accounts, {
      onLookup: () => {
        lookups += 1;
      },
    });
    await withServer({ sessions, channelSessionRecheckMs: 25 }, async (rs) => {
      let closes = 0;
      let heard: () => void = () => undefined;
      const serverSawClose = new Promise<void>((resolve) => {
        heard = resolve;
      });
      rs.registry.register('ch.bye', '/client-bye', (socket) => {
        socket.onClose(() => {
          closes += 1;
          heard();
        });
      });
      const cookie = await authCookie({ sv: 0, uid: 'row-u1', expiresIn: '2s' });
      const { exp } = await verifySession(tokenOf(cookie), KEY);
      const uncaught = watchUncaught();

      const ws = await openClient(`${rs.base}/client-bye`, { cookie });
      await closeClient(ws);
      await serverSawClose;
      // A check that was already running at the close may still land.
      await sleep(100);
      const lookupsAfterClose = lookups;
      await sleep(Math.max(0, exp * 1000 - Date.now()) + 200);

      assert.equal(lookups, lookupsAfterClose, 'no re-check runs for a closed socket');
      assert.equal(rs.registry.closeSessions(() => true), 0);
      assert.equal(closes, 1, 'the handler hears the close exactly once');
      assert.deepEqual(uncaught.stop().map((e) => e.message), []);
    });
  });

  it('deactivateChannel still closes with 1001 and stops the re-checks', FAST, async () => {
    const accounts = new Map([['local:u1', account('row-u1')]]);
    let lookups = 0;
    const sessions = revocationGuard(accounts, {
      onLookup: () => {
        lookups += 1;
      },
    });
    await withServer({ sessions, channelSessionRecheckMs: 25 }, async (rs) => {
      rs.registry.register('ch.deact', '/deact', echoHandler());
      const ws = await openClient(`${rs.base}/deact`, {
        cookie: await authCookie({ sv: 0, uid: 'row-u1' }),
      });
      const afterUpgrade = lookups;
      await sleep(100);
      assert.ok(lookups > afterUpgrade, 'the socket was being re-checked');

      const closed = closeWithin(ws, 3000);
      rs.registry.deactivateChannel('ch.deact');
      const c = await closed;
      assert.deepEqual([c.code, c.reason], [1001, 'channel deactivated']);
      // A check that was already running at the close may still land.
      await sleep(100);
      const lookupsAfterClose = lookups;
      await sleep(150);
      assert.equal(lookups, lookupsAfterClose, 'no re-check after deactivation');
    });
  });
});
