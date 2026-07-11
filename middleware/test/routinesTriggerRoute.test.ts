import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRoutinesRouter } from '../src/routes/routines.js';
import type { RoutineRunner } from '../src/plugins/routines/routineRunner.js';
import type { RoutineRunsStore } from '../src/plugins/routines/routineRunsStore.js';
import type {
  Routine,
  RoutineStore,
} from '../src/plugins/routines/routineStore.js';

/**
 * Issue #473 — POST /:id/trigger returns a synchronous 503
 * `routines.chat_unavailable` while no chat agent is published (LLM key
 * not configured), instead of a 202 whose background run is guaranteed
 * to record `error`. The moment the resolver reports an agent (Setup
 * Wizard key save), the same route flips to 202 without a restart —
 * the router-level analog of `chatSessionsRouterGraceful.test.ts`.
 */

function makeRoutine(id: string): Routine {
  const now = new Date();
  return {
    id,
    tenant: 'tenant-A',
    userId: 'user-1',
    name: 'demo',
    cron: '*/30 * * * *',
    prompt: 'Hi.',
    channel: 'teams',
    conversationRef: {},
    status: 'active',
    timeoutMs: 600_000,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    outputTemplate: null,
  };
}

class StubRunner {
  public readonly rows = new Map<string, Routine>();
  public chatAvailable = false;
  public triggerCalls: string[] = [];

  seed(routine: Routine): void {
    this.rows.set(routine.id, routine);
  }

  async peekRoutine(id: string): Promise<Routine | null> {
    return this.rows.get(id) ?? null;
  }

  chatAgentAvailable(): boolean {
    return this.chatAvailable;
  }

  async triggerRoutineNow(id: string): Promise<Routine> {
    this.triggerCalls.push(id);
    const row = this.rows.get(id);
    if (!row) throw new Error(`routine '${id}' not found`);
    return row;
  }
}

interface Harness {
  server: Server;
  baseUrl: string;
  runner: StubRunner;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const runner = new StubRunner();
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/v1/routines',
    createRoutinesRouter({
      store: {} as RoutineStore,
      runsStore: {} as RoutineRunsStore,
      runner: runner as unknown as RoutineRunner,
      log: () => {},
    }),
  );

  return new Promise<Harness>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        runner,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              r();
            });
          }),
      });
    });
  });
}

describe('POST /v1/routines/:id/trigger — chat-agent availability (issue #473)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    h.runner.seed(makeRoutine('routine-1'));
  });

  afterEach(async () => {
    await h.close();
  });

  it('returns 503 routines.chat_unavailable while no chat agent is published — without dispatching a run', async () => {
    const res = await fetch(`${h.baseUrl}/v1/routines/routine-1/trigger`, {
      method: 'POST',
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'routines.chat_unavailable');
    assert.match(body.message, /LLM API key/i);
    assert.equal(h.runner.triggerCalls.length, 0);
  });

  it('404 still wins over 503 for unknown routines', async () => {
    const res = await fetch(`${h.baseUrl}/v1/routines/nope/trigger`, {
      method: 'POST',
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'routines.not_found');
  });

  it('flips to 202 the moment the chat agent resolves — no restart, same router instance', async () => {
    const first = await fetch(`${h.baseUrl}/v1/routines/routine-1/trigger`, {
      method: 'POST',
    });
    assert.equal(first.status, 503);

    // Setup Wizard key save → reactivate → chatAgent@1 published.
    h.runner.chatAvailable = true;

    const second = await fetch(`${h.baseUrl}/v1/routines/routine-1/trigger`, {
      method: 'POST',
    });
    assert.equal(second.status, 202);
    const body = (await second.json()) as { routine: { id: string } };
    assert.equal(body.routine.id, 'routine-1');
    assert.deepEqual(h.runner.triggerCalls, ['routine-1']);
  });
});
