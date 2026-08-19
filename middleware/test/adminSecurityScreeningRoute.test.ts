import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import {
  recordScreenOutcome,
  resetSecurityScreenMetrics,
  UNSCREENABLE_STREAK_ALERT,
} from '@omadia/orchestrator';
import { createAdminRouter } from '../src/routes/admin.js';

/**
 * #749 — `/security/screening`, the answer to "is inbound screening running?"
 *
 * Written against the state that was invisible before #748: a screener failing
 * on every single turn, with the fail-open policy quietly letting each turn
 * through. The happy path is the least interesting case here.
 */

const TOKEN = 'test-admin-token';
let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/admin',
    createAdminRouter({
      token: TOKEN,
      store: {} as never, // this route touches no store
    }),
  );
  await new Promise<void>((resolve) => {
    // Bind on loopback explicitly: a wildcard listen(0) plus a 127.0.0.1 dial
    // has produced cross-process port collisions in this suite before.
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  resetSecurityScreenMetrics();
});

const get = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}/admin/security/screening`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('#749 GET /admin/security/screening', () => {
  it('requires the admin token', async () => {
    const res = await fetch(`${base}/admin/security/screening`);
    assert.equal(res.status, 401);
  });

  it('reports healthy with nothing screened yet, and no NaN rate', async () => {
    const { status, body } = await get();

    assert.equal(status, 200);
    assert.equal(body['healthy'], true);
    assert.equal(body['screened'], 0);
    assert.equal(body['unscreenableRate'], 0);
    assert.equal(body['alertThreshold'], UNSCREENABLE_STREAK_ALERT);
  });

  it('reports UNHEALTHY when the screener fails on every turn', async () => {
    // The pre-#748 state, verbatim: every screen raised, every turn ran anyway.
    for (let i = 0; i < 30; i++) {
      recordScreenOutcome('unscreenable', 'provider-rejected', () => {});
    }

    const { body } = await get();

    assert.equal(body['healthy'], false);
    assert.equal(body['unscreenableRate'], 1);
    assert.equal(body['consecutiveUnscreenable'], 30);
    assert.deepEqual(
      (body['byCause'] as Record<string, number>)['provider-rejected'],
      30,
      'the cause must survive to the wire — a bare count would not say WHY',
    );
  });

  it('stays healthy through an isolated miss', async () => {
    // Guards the other direction. An endpoint that flips to unhealthy on one
    // transient failure is an endpoint operators learn to ignore.
    for (let i = 0; i < 40; i++) recordScreenOutcome('allow', undefined, () => {});
    recordScreenOutcome('unscreenable', 'provider-unavailable', () => {});

    const { body } = await get();

    assert.equal(body['healthy'], true);
    assert.equal(body['consecutiveUnscreenable'], 1);
  });

  it('still reports the worst streak after a recovery', async () => {
    for (let i = 0; i < 12; i++) recordScreenOutcome('unscreenable', 'unknown', () => {});
    recordScreenOutcome('allow', undefined, () => {});

    const { body } = await get();

    assert.equal(body['healthy'], true, 'it recovered');
    assert.equal(body['worstConsecutiveUnscreenable'], 12, 'but the episode is on record');
  });
});
