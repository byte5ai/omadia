/**
 * The builder event stream (`GET /drafts/:id/events`) ends with the session
 * that opened it. A fake response and mocked timers pin down the edges a real
 * socket cannot:
 *
 *   - a stream whose session stands stays open across heartbeats, and each
 *     heartbeat checks the session again (the control);
 *   - the stream ends at `exp` exactly, and an event due after `exp` is
 *     dropped even while the expiry timer runs late;
 *   - a revocation announced on this replica ends that user's stream at once;
 *   - a revocation written elsewhere (no announcement here) ends it at the
 *     next heartbeat's check, and one written before the listener existed at
 *     the check that runs when the stream opens;
 *   - an outage keeps the stream, a slow check is not doubled, and a refusal
 *     that arrives after the deadline still ends it;
 *   - after the end nothing is written and no listener or timer is left.
 *
 * The real-socket behaviour lives in `builderEventsRoutes.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Request, Response, Router } from 'express';

import type { SessionEvaluation } from '../../src/auth/requireAuth.js';
import type {
  RevocationListener,
  RevokedPrincipal,
} from '../../src/auth/sessionRevocation.js';
import type { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import { registerBuilderEventsRoutes } from '../../src/routes/builderEvents.js';
import {
  NOW_MS,
  NOW_S,
  OK,
  REVOKED,
  UNAVAILABLE,
  deferred,
  settle,
} from '../_helpers/channelSessionFakes.js';

const HEARTBEAT_MS = 25_000;
const HOUR_S = 3_600;
const MAX_TIMER_MS = 2 ** 31 - 1;
const OWNER = 'owner@example.com';
const DRAFT_ID = 'draft-1';
const TOKEN = 'session-token-of-owner';

/** The slice of an Express response the route touches. */
class FakeResponse extends EventEmitter {
  statusCode = 0;
  body: unknown;
  writableEnded = false;
  /** Writes after `end()`: the route swallows a throwing write, so count them. */
  lateWrites = 0;
  readonly chunks: string[] = [];

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.writableEnded = true;
    return this;
  }

  setHeader(): void {}

  flushHeaders(): void {}

  write(chunk: string): boolean {
    if (this.writableEnded) this.lateWrites += 1;
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }

  /** Names of the SSE events written so far. */
  events(): string[] {
    return this.chunks
      .filter((c) => c.startsWith('event: '))
      .map((c) => c.slice('event: '.length).trim());
  }

  pings(): number {
    return this.chunks.filter((c) => c === ': ping\n\n').length;
  }
}

/** `SessionRevocation`'s push side, with its listeners in view. */
class FakeRevocations {
  readonly listeners = new Set<RevocationListener>();

  onRevoked(listener: RevocationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  announce(who: RevokedPrincipal): void {
    for (const listener of [...this.listeners]) listener(who);
  }
}

interface Stream {
  readonly res: FakeResponse;
  readonly bus: SpecEventBus;
  readonly revocations: FakeRevocations;
  /** Tokens handed to `evaluate`, one per session check. */
  readonly checks: string[];
  /** What the next checks answer. */
  answer(next: () => Promise<SessionEvaluation>): void;
  /** Emit one event for the stream's draft. */
  emit(): void;
}

interface OpenOptions {
  exp?: number;
  heartbeatMs?: number;
  checkTimeoutMs?: number;
  answer?: () => Promise<SessionEvaluation>;
  cookie?: string | null;
  claims?: Record<string, unknown>;
  email?: string;
}

async function openStream(opts: OpenOptions = {}): Promise<Stream> {
  const bus = new SpecEventBus();
  const revocations = new FakeRevocations();
  const checks: string[] = [];
  let answer = opts.answer ?? (() => Promise.resolve(OK));
  const draftStore = {
    load: (email: string, id: string) =>
      Promise.resolve(email === OWNER && id === DRAFT_ID ? { id } : null),
  } as unknown as DraftStore;

  let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
  const router = {
    get: (_path: string, h: (req: Request, res: Response) => Promise<void>) => {
      handler = h;
    },
  } as unknown as Router;
  registerBuilderEventsRoutes(router, {
    draftStore,
    bus,
    heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_MS,
    sessions: {
      evaluate: (token) => {
        checks.push(token);
        return answer();
      },
      revocations,
      ...(opts.checkTimeoutMs !== undefined ? { checkTimeoutMs: opts.checkTimeoutMs } : {}),
    },
  });

  const email = opts.email ?? OWNER;
  const req = {
    params: { id: DRAFT_ID },
    session: opts.claims ?? {
      email,
      sub: email,
      provider: 'local',
      exp: opts.exp ?? NOW_S + HOUR_S,
    },
    cookies: opts.cookie === null ? {} : { omadia_session: opts.cookie ?? TOKEN },
  } as unknown as Request;
  const res = new FakeResponse();
  assert.ok(handler, 'route registered');
  await handler(req, res as unknown as Response);
  // The check that runs when the stream opens.
  await settle();

  return {
    res,
    bus,
    revocations,
    checks,
    answer(next) {
      answer = next;
    },
    emit() {
      bus.emit(DRAFT_ID, { type: 'lint_result', issues: [], cause: 'agent' });
    },
  };
}

/** Advance the mocked clock and let the checks it started settle. */
async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await settle();
}

/** The stream ended and left nothing behind: no listener, no timer, no write. */
async function assertEndedClean(s: Stream): Promise<void> {
  assert.equal(s.res.writableEnded, true, 'stream ended');
  assert.equal(s.bus.listenerCount(DRAFT_ID), 0, 'bus listener removed');
  assert.equal(s.revocations.listeners.size, 0, 'revocation listener removed');
  const written = s.res.chunks.length;
  const checks = s.checks.length;
  s.emit();
  s.revocations.announce({ provider: 'local', sub: OWNER });
  await advance(10 * HEARTBEAT_MS);
  assert.equal(s.res.chunks.length, written, 'nothing written after the end');
  assert.equal(s.res.lateWrites, 0);
  assert.equal(s.checks.length, checks, 'no heartbeat and no check after the end');
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW_MS });
});

afterEach(() => {
  mock.timers.reset();
});

describe('builder event stream — a standing session', () => {
  it('stays open across several heartbeats and checks the session with each', async () => {
    const s = await openStream();
    assert.deepEqual(s.checks, [TOKEN], 'one check when the stream opens');

    for (let beat = 1; beat <= 4; beat += 1) {
      await advance(HEARTBEAT_MS);
      assert.equal(s.res.pings(), beat);
      assert.equal(s.checks.length, 1 + beat, 'one check per heartbeat');
    }
    s.emit();

    assert.equal(s.res.writableEnded, false);
    assert.deepEqual(s.res.events(), ['lint_result']);
    assert.equal(s.bus.listenerCount(DRAFT_ID), 1);
    assert.equal(s.revocations.listeners.size, 1);
    assert.ok(s.checks.every((token) => token === TOKEN), 'every check uses the stream’s own token');
  });
});

describe('builder event stream — expiry', () => {
  it('ends at exp exactly, not a millisecond earlier, and writes nothing after it', async () => {
    const s = await openStream({ exp: NOW_S + 60 });
    await advance(59_999);
    s.emit();
    assert.equal(s.res.writableEnded, false, 'still inside the session');
    assert.deepEqual(s.res.events(), ['lint_result']);

    await advance(1);
    await assertEndedClean(s);
    assert.deepEqual(s.res.events(), ['lint_result']);
  });

  it('drops an event due after exp while the expiry timer runs late, and ends the stream', async () => {
    const s = await openStream({ exp: NOW_S + 60 });
    // The wall clock passes exp; no timer has fired yet.
    mock.timers.setTime(NOW_MS + 60_000);
    s.emit();

    assert.deepEqual(s.res.events(), [], 'the late event is not written');
    await assertEndedClean(s);
  });

  it('re-arms an exp beyond setTimeout’s ceiling instead of firing early', async () => {
    const exp = NOW_S + Math.ceil(MAX_TIMER_MS / 1000) + HOUR_S;
    const s = await openStream({ exp, heartbeatMs: 0 });
    await advance(MAX_TIMER_MS);
    assert.equal(s.res.writableEnded, false, 'the first timer only re-arms');

    await advance(exp * 1000 - Date.now());
    await assertEndedClean(s);
  });
});

describe('builder event stream — revocation on this replica', () => {
  it('ends at once when the owner’s sessions are revoked here, and only then', async () => {
    const s = await openStream();
    s.revocations.announce({ provider: 'local', sub: 'someone-else@example.com' });
    s.revocations.announce({ provider: 'entra', sub: OWNER });
    assert.equal(s.res.writableEnded, false, 'another identity’s revocation leaves it open');

    s.revocations.announce({ provider: 'local', sub: OWNER });
    await assertEndedClean(s);
    assert.equal(s.res.pings(), 0, 'no heartbeat was needed');
  });
});

describe('builder event stream — revocation on another replica', () => {
  it('ends at the next heartbeat’s check when the store no longer vouches for the session', async () => {
    const s = await openStream();
    // Revoked elsewhere: the session version moved on, nothing is announced here.
    s.answer(() => Promise.resolve(REVOKED));

    await advance(HEARTBEAT_MS - 1);
    assert.equal(s.res.writableEnded, false, 'no check before the heartbeat');

    await advance(1);
    assert.equal(s.checks.length, 2);
    await assertEndedClean(s);
  });

  it('ends right after opening when the revocation landed before its listener existed', async () => {
    const s = await openStream({ answer: () => Promise.resolve(REVOKED) });

    assert.equal(s.res.pings(), 0);
    await assertEndedClean(s);
  });

  for (const code of ['auth.not_whitelisted', 'auth.invalid'] as const) {
    it(`ends on a check that answers ${code}`, async () => {
      const s = await openStream();
      s.answer(() => Promise.resolve({ ok: false, code, message: code }));
      await advance(HEARTBEAT_MS);
      await assertEndedClean(s);
    });
  }
});

describe('builder event stream — no verdict', () => {
  it('keeps the stream through an outage and ends it once a check refuses the session', async () => {
    const s = await openStream({ answer: () => Promise.resolve(UNAVAILABLE) });
    s.emit();
    await advance(HEARTBEAT_MS);
    assert.equal(s.res.writableEnded, false, 'an outage is not a verdict');
    assert.deepEqual(s.res.events(), ['lint_result']);

    s.answer(() => Promise.resolve(REVOKED));
    await advance(HEARTBEAT_MS);
    await assertEndedClean(s);
  });

  it('treats a throwing check as an outage', async () => {
    const s = await openStream({ answer: () => Promise.reject(new Error('pool gone')) });
    await advance(HEARTBEAT_MS);
    assert.equal(s.res.writableEnded, false);
    assert.equal(s.checks.length, 2);
  });

  it('does not double a slow check, and a refusal after the deadline still ends the stream', async () => {
    const slow = deferred<SessionEvaluation>();
    const s = await openStream({ answer: () => slow.promise, checkTimeoutMs: 40_000 });

    await advance(HEARTBEAT_MS);
    assert.equal(s.checks.length, 1, 'the heartbeat joins the check in flight');

    await advance(15_000);
    assert.equal(s.res.writableEnded, false, 'a missed deadline is not a verdict');

    slow.resolve(REVOKED);
    await settle();
    await assertEndedClean(s);
  });
});

describe('builder event stream — transport and scope', () => {
  it('drops every listener and timer when the client goes away first', async () => {
    const slow = deferred<SessionEvaluation>();
    const s = await openStream({ answer: () => slow.promise });
    s.res.emit('close');

    assert.equal(s.bus.listenerCount(DRAFT_ID), 0);
    assert.equal(s.revocations.listeners.size, 0);
    slow.resolve(REVOKED);
    await settle();
    await advance(10 * HEARTBEAT_MS);
    assert.equal(s.res.pings(), 0, 'heartbeat stopped');
    assert.equal(s.checks.length, 1, 'no check after the close');
  });

  it('keeps a failing transport end away from the code that emitted the event', async () => {
    const s = await openStream({ exp: NOW_S + 60 });
    s.res.end = () => {
      throw new Error('socket already gone');
    };
    mock.timers.setTime(NOW_MS + 60_000);

    assert.doesNotThrow(() => s.emit());
    assert.deepEqual(s.res.events(), []);
    assert.equal(s.bus.listenerCount(DRAFT_ID), 0);
    assert.equal(s.revocations.listeners.size, 0);
  });

  it('refuses to open a stream it cannot bind to a session', async () => {
    for (const opts of [
      { cookie: null },
      { claims: { email: OWNER, sub: OWNER, provider: 'local' } },
      { claims: { email: OWNER, provider: 'local', exp: NOW_S + HOUR_S } },
    ] satisfies OpenOptions[]) {
      const s = await openStream(opts);
      assert.equal(s.res.statusCode, 401);
      assert.deepEqual(s.res.body, { code: 'auth.missing', message: 'no session' });
      assert.equal(s.bus.listenerCount(DRAFT_ID), 0);
      assert.equal(s.revocations.listeners.size, 0);
      assert.equal(s.checks.length, 0);
    }
  });

  it('keeps the owner scope: another user’s session cannot open the draft', async () => {
    const s = await openStream({ email: 'intruder@example.com' });
    assert.equal(s.res.statusCode, 404);
    assert.equal(s.bus.listenerCount(DRAFT_ID), 0);
    assert.equal(s.revocations.listeners.size, 0);
  });
});
