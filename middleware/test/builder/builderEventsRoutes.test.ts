import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { DraftQuota } from '../../src/plugins/builder/draftQuota.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import { createBuilderRouter } from '../../src/routes/builder.js';

function withSessionEmail(email: string | null): express.RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { session: { email: string | null } }).session = { email };
    next();
  };
}

interface TestApp {
  server: Server;
  port: number;
  draftStore: DraftStore;
  bus: SpecEventBus;
  draftId: string;
  userEmail: string;
  tmpRoot: string;
  close: () => Promise<void>;
}

async function createTestApp(opts: { email?: string | null } = {}): Promise<TestApp> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-events-routes-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();
  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Test');
  const bus = new SpecEventBus();
  const draftQuota = new DraftQuota({ store: draftStore, max: 50 });

  const app: Express = express();
  app.use(express.json());
  app.use(withSessionEmail(opts.email === undefined ? userEmail : opts.email));
  app.use(
    '/api/v1/builder',
    createBuilderRouter({
      store: draftStore,
      quota: draftQuota,
      events: { draftStore, bus, heartbeatMs: 0 },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    draftStore,
    bus,
    draftId: draft.id,
    userEmail,
    tmpRoot,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

interface SseDispatch {
  event: string | null;
  data: string;
}

/**
 * Open a raw http GET against `path` and yield SSE dispatches as they
 * arrive. Comment lines (`: ping`, `retry:`) are skipped — only event/data
 * blocks make it out. The promise resolves once the consumer aborts via
 * the returned `close()`. Per-test timeout via `consume(maxDispatches)`.
 */
function openSseClient(
  port: number,
  path_: string,
): {
  consume: (n: number, timeoutMs?: number) => Promise<SseDispatch[]>;
  status: () => Promise<number>;
  close: () => void;
  rawResponse: () => Promise<http.IncomingMessage>;
} {
  let resolveResp: (m: http.IncomingMessage) => void = () => {};
  let rejectResp: (err: Error) => void = () => {};
  const respPromise = new Promise<http.IncomingMessage>((resolve, reject) => {
    resolveResp = resolve;
    rejectResp = reject;
  });
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: path_,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    },
    (res) => {
      resolveResp(res);
    },
  );
  req.on('error', (err) => rejectResp(err));
  req.end();

  const dispatches: SseDispatch[] = [];
  let buffer = '';
  let pendingEvent: string | null = null;
  let pendingData: string[] = [];
  const waiters: Array<{
    n: number;
    resolve: (out: SseDispatch[]) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const flushDispatch = (): void => {
    if (pendingData.length === 0 && pendingEvent === null) return;
    if (pendingData.length > 0) {
      dispatches.push({ event: pendingEvent, data: pendingData.join('\n') });
      // Resolve any waiter whose target count is met.
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const w = waiters[i];
        if (w && dispatches.length >= w.n) {
          clearTimeout(w.timer);
          w.resolve(dispatches.slice(0, w.n));
          waiters.splice(i, 1);
        }
      }
    }
    pendingEvent = null;
    pendingData = [];
  };

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const raw = buffer.slice(0, nl);
      const line = raw.replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        flushDispatch();
      } else if (line.startsWith(':')) {
        // comment / heartbeat
      } else if (line.startsWith('event:')) {
        pendingEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        pendingData.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('retry:')) {
        // ignore
      }
      nl = buffer.indexOf('\n');
    }
  };

  void respPromise.then((res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => onData(Buffer.from(chunk, 'utf8')));
  });

  return {
    async rawResponse() {
      return respPromise;
    },
    async status() {
      const res = await respPromise;
      return res.statusCode ?? 0;
    },
    consume(n, timeoutMs = 1500) {
      if (dispatches.length >= n) return Promise.resolve(dispatches.slice(0, n));
      return new Promise<SseDispatch[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `SSE timeout after ${String(timeoutMs)}ms — got ${String(dispatches.length)}/${String(n)}`,
            ),
          );
        }, timeoutMs);
        waiters.push({ n, resolve, timer });
      });
    },
    close() {
      try {
        req.destroy();
      } catch {
        // ignore
      }
    },
  };
}

async function getJson(
  port: number,
  path_: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: path_,
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(body) as Record<string, unknown>,
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/v1/builder/drafts/:id/events', () => {
  let app: TestApp;
  let openedClients: Array<{ close: () => void }> = [];

  afterEach(async () => {
    for (const c of openedClients) c.close();
    openedClients = [];
    if (app) await app.close();
  });

  it('forwards spec_patch events with cause=user from the bus to the SSE stream', async () => {
    app = await createTestApp();
    const client = openSseClient(
      app.port,
      `/api/v1/builder/drafts/${app.draftId}/events`,
    );
    openedClients.push(client);
    assert.equal(await client.status(), 200);

    // Wait a tick so the route reaches `bus.subscribe`.
    await new Promise((r) => setTimeout(r, 30));

    app.bus.emit(app.draftId, {
      type: 'spec_patch',
      patches: [{ op: 'replace', path: '/name', value: 'Foo' }],
      cause: 'user',
    });
    app.bus.emit(app.draftId, {
      type: 'slot_patch',
      slotKey: 'system-prompt',
      source: '...',
      cause: 'user',
    });

    const dispatches = await client.consume(2);
    assert.equal(dispatches[0]?.event, 'spec_patch');
    assert.equal(dispatches[1]?.event, 'slot_patch');
    const parsed = JSON.parse(dispatches[0]?.data ?? '{}') as {
      type: string;
      cause: string;
    };
    assert.equal(parsed.type, 'spec_patch');
    assert.equal(parsed.cause, 'user');
  });

  it('forwards agent-cause events too', async () => {
    app = await createTestApp();
    const client = openSseClient(
      app.port,
      `/api/v1/builder/drafts/${app.draftId}/events`,
    );
    openedClients.push(client);
    await new Promise((r) => setTimeout(r, 30));

    app.bus.emit(app.draftId, {
      type: 'lint_result',
      issues: [],
      cause: 'agent',
    });

    const dispatches = await client.consume(1);
    assert.equal(dispatches[0]?.event, 'lint_result');
    const parsed = JSON.parse(dispatches[0]?.data ?? '{}') as {
      type: string;
      cause: string;
    };
    assert.equal(parsed.cause, 'agent');
  });

  it('does not leak events from a different draftId', async () => {
    app = await createTestApp();
    const client = openSseClient(
      app.port,
      `/api/v1/builder/drafts/${app.draftId}/events`,
    );
    openedClients.push(client);
    await new Promise((r) => setTimeout(r, 30));

    app.bus.emit('different-draft', {
      type: 'spec_patch',
      patches: [],
      cause: 'user',
    });
    app.bus.emit(app.draftId, {
      type: 'slot_patch',
      slotKey: 'k',
      source: 's',
      cause: 'user',
    });

    const dispatches = await client.consume(1);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]?.event, 'slot_patch');
  });

  it('returns 404 when the draft does not belong to the caller', async () => {
    app = await createTestApp();
    const res = await getJson(
      app.port,
      `/api/v1/builder/drafts/no-such-draft/events`,
    );
    assert.equal(res.status, 404);
    assert.equal(res.body['code'], 'builder.draft_not_found');
  });

  it('rejects with 401 without a session', async () => {
    app = await createTestApp({ email: null });
    const res = await getJson(
      app.port,
      `/api/v1/builder/drafts/${app.draftId}/events`,
    );
    assert.equal(res.status, 401);
    assert.equal(res.body['code'], 'auth.missing');
  });

  it('registers exactly one bus listener while the SSE stream is open and drops it on disconnect', async () => {
    app = await createTestApp();
    assert.equal(app.bus.listenerCount(app.draftId), 0);

    const client = openSseClient(
      app.port,
      `/api/v1/builder/drafts/${app.draftId}/events`,
    );
    openedClients.push(client);
    await client.rawResponse();
    // Wait for the route to register subscribe().
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.bus.listenerCount(app.draftId), 1);

    client.close();
    // Server-side `res.on('close', close)` fires async on socket close.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.bus.listenerCount(app.draftId), 0);
  });
});
