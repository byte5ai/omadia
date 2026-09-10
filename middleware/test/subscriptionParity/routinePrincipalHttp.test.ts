/**
 * OM-82 — the routines principal has to survive a real HTTP chat turn, all the
 * way to a tool dispatched over the CLI bridge's loopback MCP server.
 *
 * The round-4 investigation concluded the context "did not survive the process
 * boundary" and #993 taught the loopback dispatch to restore the caller's async
 * context; #1016 taught it to refuse a stale one. Both hardened the TRANSPORT
 * of a value nothing ever installed on this path: the only writer of
 * `routineTurnContext` in the tree is `RoutinesIntegration.captureRoutineTurn`,
 * which only the out-of-tree Teams adapter calls. On the web chat the store was
 * empty for the whole turn, `manage_routine` refused, and the model rendered
 * that refusal in German as "Ihre Benutzerdaten sind … nicht beim Tool
 * angekommen".
 *
 * Both routes are covered, because they install the context differently
 * (`run` around a promise vs `run` around the generator plus its drain loop),
 * and both are checked for leaking a principal into a later request — the
 * in-process runtime has no owner guard to catch one (#1016 guards the CLI
 * agent only).
 */
import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import type {
  ChatAgent,
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
} from '@omadia/orchestrator';

import { createChatRouter } from '../../src/routes/chat.js';
import { routineTurnContext } from '../../src/plugins/routines/routineTurnContext.js';
import type { ManageRoutineContext } from '../../src/plugins/routines/manageRoutineTool.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

const SLUG = 'general';
const USER_ID = 'user-om82';

/** What `manage_routine`'s resolver saw during the most recent dispatch. */
let toolSawContext: ManageRoutineContext | undefined;
let dispatchRan = false;
/** Session identity the next request should carry; `undefined` = anonymous. */
let sessionUser: string | undefined;

/**
 * Read the capture through a function: assigning `undefined` at the top of a
 * case would otherwise let control-flow analysis narrow the module-level
 * binding to `never`, since it cannot see that the HTTP round trip writes it.
 */
function seenContext(): ManageRoutineContext | undefined {
  return toolSawContext;
}

/** Mirrors `initRoutines.ts`: `resolveContext: () => routineTurnContext.current()`. */
function dispatchTool(): void {
  dispatchRan = true;
  toolSawContext = routineTurnContext.current();
}

/**
 * A chat agent that behaves like `CliChatAgent` in the one respect this test is
 * about: it snapshots the caller's async context at the public entry point and
 * restores it around a later tool dispatch, exactly as the loopback MCP server
 * does for the spawned CLI. If the principal reaches the tool here, it reaches
 * it there.
 */
function bridgeLikeChatAgent(): ChatAgent {
  return {
    chat: async (_input: ChatTurnInput): Promise<ChatTurnResult> => {
      const runInTurnContext = AsyncLocalStorage.snapshot();
      // A tick, so the dispatch genuinely resumes on a different async
      // resource than the one that captured the snapshot.
      await new Promise((resolve) => setTimeout(resolve, 0));
      runInTurnContext(dispatchTool);
      return { kind: 'message', text: 'ok' } as unknown as ChatTurnResult;
    },
    chatStream: async function* (): AsyncGenerator<ChatStreamEvent> {
      const runInTurnContext = AsyncLocalStorage.snapshot();
      yield { type: 'iteration_start', iteration: 1 } as unknown as ChatStreamEvent;
      await new Promise((resolve) => setTimeout(resolve, 0));
      runInTurnContext(dispatchTool);
      yield { type: 'text_delta', text: 'ok' } as unknown as ChatStreamEvent;
    },
  } as unknown as ChatAgent;
}

/** Stand in for `requireAuth`, which is what populates `omadia_user_id`. */
function fakeSession(req: Request, _res: Response, next: NextFunction): void {
  const mutable = req as { session?: unknown };
  mutable.session = sessionUser ? { omadia_user_id: sessionUser } : {};
  next();
}

async function post(url: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message: 'liste meine routinen' }),
  });
  // Drain the stream so the handler finishes before the assertions run.
  await res.text();
  return res.status;
}

describe('OM-82 — routines principal on the HTTP chat path', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(fakeSession);
    app.use(
      '/api',
      createChatRouter({
        resolveChatAgent: (slug) => (slug === SLUG ? bridgeLikeChatAgent() : undefined),
        getDefaultSlug: () => SLUG,
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  for (const route of ['/chat', '/chat/stream'] as const) {
    it(`${route}: delivers the principal to a tool dispatched inside the turn`, async () => {
      toolSawContext = undefined;
      dispatchRan = false;
      sessionUser = USER_ID;

      assert.equal(await post(`${baseUrl}${route}`), 200);
      assert.equal(dispatchRan, true, 'the dispatch ran');
      const seen = seenContext();
      assert.ok(seen, 'manage_routine saw a user context');
      assert.equal(seen.userId, USER_ID);
      assert.equal(seen.channel, 'web');
      // Cold-start outreach to other people needs a channel governance source
      // the web chat does not have, so it stays closed.
      assert.equal(seen.canTargetOthers, false);
    });

    it(`${route}: installs no context for an anonymous request`, async () => {
      toolSawContext = undefined;
      dispatchRan = false;
      sessionUser = undefined;

      assert.equal(await post(`${baseUrl}${route}`), 200);
      assert.equal(dispatchRan, true, 'the dispatch ran');
      // The #1016 owner guard REFUSES when a context is present but the turn
      // has no userId to match it against, so an anonymous context would turn
      // the tool's graceful refusal into a hard guard failure.
      assert.equal(seenContext(), undefined);
    });

    it(`${route}: ignores the client-controlled x-user-id header`, async () => {
      toolSawContext = undefined;
      sessionUser = undefined;

      // `manage_routine` scopes pause/resume/delete to the context's
      // (tenant, userId) (#1025). Honouring this header would let any caller
      // name a victim and manage their routines, and the owner guard could not
      // catch it — both sides of its comparison would be the forged value.
      assert.equal(await post(`${baseUrl}${route}`, { 'x-user-id': 'victim' }), 200);
      assert.equal(seenContext(), undefined);
    });

    it(`${route}: does not leak the principal into a later anonymous request`, async () => {
      sessionUser = USER_ID;
      await post(`${baseUrl}${route}`);

      toolSawContext = undefined;
      sessionUser = undefined;
      await post(`${baseUrl}${route}`);
      assert.equal(seenContext(), undefined);
    });
  }
});
