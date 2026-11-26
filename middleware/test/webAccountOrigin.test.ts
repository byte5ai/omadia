/**
 * #1774 / #1826 (ADR-0182) — web chat and web routine turns run in the
 * signed-in account's one-person room; the origin comes from the session only.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { isWebAccountTurn, webAccountOrigin } from '@omadia/orchestrator';
import type { ChatAgent, ChatTurnInput, ChatTurnResult } from '@omadia/orchestrator';
import { resolveTurnAudience } from '@omadia/orchestrator/dist/turnAudience.js';

import { createChatRouter } from '../src/routes/chat.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { routeTurnFrom } from './_helpers/webRouteTurn.js';

const ANNA = '11111111-2222-4333-8444-555555555555';

describe('#1774 — web account origin', () => {
  it('is a personal http scope keyed on the account', () => {
    assert.deepEqual(webAccountOrigin(ANNA), {
      channelType: 'http',
      scope: { kind: 'personal', userId: ANNA },
      conversationType: 'direct',
    });
  });

  it('counts as a web account turn only when the origin names the turn user', () => {
    assert.equal(isWebAccountTurn({ userId: ANNA, origin: webAccountOrigin(ANNA) }), true);
    assert.equal(isWebAccountTurn({ userId: 'someone-else', origin: webAccountOrigin(ANNA) }), false);
    assert.equal(
      isWebAccountTurn({
        userId: ANNA,
        origin: webAccountOrigin(ANNA),
        channelIdentity: { channelKind: 'teams', channelUserId: ANNA },
      }),
      false,
    );
  });

  it('a web account turn is a one-person audience without an identity lookup', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const audience = await resolveTurnAudience(kg, { userId: ANNA, origin: webAccountOrigin(ANNA) }, undefined);
    assert.deepEqual(audience, { kind: 'known', members: [ANNA] });
  });
});

describe('#1774 — the chat route builds the origin from the session only', () => {
  let server: Server;
  let base: string;
  const seen: ChatTurnInput[] = [];
  const agent = {
    chat: (input: ChatTurnInput) => {
      seen.push(input);
      return Promise.resolve({ kind: 'message', text: 'ok' } as unknown as ChatTurnResult);
    },
    chatStream: () => {
      throw new Error('not used');
    },
  } as unknown as ChatAgent;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.header('x-test-session-user');
      (req as unknown as { session: unknown }).session = id ? { sub: 'acc', omadia_user_id: id } : undefined;
      next();
    });
    app.use('/api', createChatRouter({ routeTurn: routeTurnFrom(() => agent, () => 'general') }));
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const send = (headers: Record<string, string>) =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ message: 'hi', scope: 'someone-elses-label' }),
    });

  it('a signed-in turn carries the account origin, whatever scope the body names', async () => {
    seen.length = 0;
    assert.equal((await send({ 'x-test-session-user': ANNA })).status, 200);
    assert.deepEqual(seen[0]?.origin, webAccountOrigin(ANNA));
    assert.equal(seen[0]?.userId, ANNA);
  });

  it('the x-user-id header never builds an origin', async () => {
    seen.length = 0;
    assert.equal((await send({ 'x-user-id': ANNA })).status, 200);
    assert.equal(seen[0]?.origin, undefined);
  });
});

describe('#1774 — routine runs', () => {
  it('a web routine runs in its owner’s room; other channels get no origin', async () => {
    const { routineOrigin } = await import('../src/plugins/routines/routineRunner.js');
    assert.deepEqual(routineOrigin({ channel: 'web', userId: ANNA }), { origin: webAccountOrigin(ANNA) });
    assert.deepEqual(routineOrigin({ channel: 'teams', userId: 'aad-anna' }), {});
  });
});
