import type { Router, Request, Response } from 'express';

import { SESSION_COOKIE } from '../auth/requireAuth.js';
import type { AutoFixOrchestrator } from '../plugins/builder/autoFixOrchestrator.js';
import type { DraftStore } from '../plugins/builder/draftStore.js';
import type { SpecEventBus } from '../plugins/builder/specEventBus.js';

import {
  watchStreamSession,
  type StreamSession,
  type StreamSessionDeps,
} from './builderEventsSession.js';

/**
 * Builder events route (Phase B.5-4).
 *
 *   GET /drafts/:id/events  → Server-Sent-Events stream of every
 *                              SpecBusEvent emitted for this draft.
 *
 * Source-agnostic: forwards both `cause: 'agent'` (BuilderAgent tool calls)
 * and `cause: 'user'` (inline-editor PATCH endpoints) events. Two browser
 * tabs editing the same draft both subscribe and stay in sync without
 * re-fetching the whole draft on every mutation.
 *
 * Uses native SSE so the browser's EventSource handles auto-reconnect for
 * us. Heartbeat comment lines keep idle proxies (Cloudflare, nginx default)
 * from killing the connection — 25 s is comfortably under the standard
 * 60 s idle window.
 *
 * Owner-scoped: a draft belonging to user A is unreachable for user B
 * (DraftStore.load filters by user_email).
 *
 * Session-bound: the stream ends with the session that opened it, at the
 * token's `exp`, on a revocation announced on this replica, and when a
 * session check refuses it. That check runs right after the stream opens and
 * with every heartbeat (`builderEventsSession.ts`). No event is written after
 * the end.
 */

export interface BuilderEventsDeps {
  draftStore: DraftStore;
  bus: SpecEventBus;
  /** Option-C, C-4: opt-in. When provided, every SSE-connect arms the
   *  AutoFixOrchestrator for this (draftId, userEmail) so backend-side
   *  failure-loops trigger Builder turns even before any operator
   *  click. Idempotent — re-mount/multi-tab is safe. */
  autoFixOrchestrator?: AutoFixOrchestrator;
  /** Session lifetime of an open stream. `index.ts` wires
   *  `evaluateSessionToken` with `requireAuth`'s deps and the kernel's
   *  revocation guard. */
  sessions: StreamSessionDeps;
  /** Heartbeat interval in ms, also the cadence of the session check.
   *  Default 25_000. Tests override to 0 (no heartbeat, no periodic check). */
  heartbeatMs?: number;
  /** Test seam — use a faster timer in tests. */
  setTimer?: (fn: () => void, ms: number) => { unref(): void } | NodeJS.Timeout;
  /** Test seam — pair with `setTimer`. */
  clearTimer?: (
    timer: ReturnType<NonNullable<BuilderEventsDeps['setTimer']>>,
  ) => void;
}

const DEFAULT_HEARTBEAT_MS = 25_000;

export function registerBuilderEventsRoutes(
  router: Router,
  deps: BuilderEventsDeps,
): void {
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    });
  const clearTimer =
    deps.clearTimer ??
    ((t) => {
      clearInterval(t as NodeJS.Timeout);
    });

  router.get('/drafts/:id/events', async (req: Request, res: Response) => {
    const email = readEmail(req);
    const session = readStreamSession(req);
    if (!email || !session) {
      sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
      return;
    }
    const draftId = readId(req);
    if (!draftId) {
      sendJson(res, 400, {
        code: 'builder.invalid_id',
        message: 'missing :id',
      });
      return;
    }

    // Owner-scope guard.
    const draft = await deps.draftStore.load(email, draftId);
    if (!draft) {
      sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
      return;
    }

    // Open the SSE stream.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Browsers' EventSource respects `retry:` to control reconnect delay
    // after a transport drop. Our bus-driven stream is cheap to reopen,
    // so a short retry keeps tabs feeling live.
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    // C-4: arm the AutoFix loop now that we know there is an active
    // operator session for this draft. ensureSubscribed is idempotent
    // and never throws on its own; logging stays inside the orchestrator.
    deps.autoFixOrchestrator?.ensureSubscribed(draftId, email);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimer(heartbeat);
      unsubscribe();
      watch.dispose();
      if (!res.writableEnded) res.end();
    };

    const watch = watchStreamSession(session, deps.sessions, (reason) => {
      console.log(`[builder] event stream ended (draft=${draftId}, reason=${reason})`);
      close();
    });

    const unsubscribe = deps.bus.subscribe(draftId, (ev) => {
      if (closed || !watch.isCurrent()) return;
      // SSE event-line format: each named event becomes its own dispatch
      // bucket on the client side via `addEventListener('<name>', …)`.
      // Embed the cause inside the JSON payload so a single 'data' handler
      // can also discriminate.
      try {
        res.write(`event: ${ev.type}\n`);
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        // Underlying socket is gone — drop the subscription.
        close();
      }
    });

    const heartbeat =
      heartbeatMs > 0
        ? setTimer(() => {
            if (closed || !watch.isCurrent()) return;
            try {
              res.write(': ping\n\n');
            } catch {
              close();
              return;
            }
            watch.check();
          }, heartbeatMs)
        : ({ unref(): void {} } as ReturnType<typeof setTimer>);

    res.once('close', close);
    // A revocation that landed between the request's own check and the
    // listener above is caught here instead of at the first heartbeat.
    watch.check();
  });
}

// ---------------------------------------------------------------------------

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

/**
 * The session the stream is bound to: the cookie `requireAuth` verified and
 * the claims it set, `exp` included. Null when any of it is missing, so a
 * stream is never opened without an end.
 */
function readStreamSession(req: Request): StreamSession | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[SESSION_COOKIE];
  const claims = req.session as { provider?: unknown; sub?: unknown; exp?: unknown } | undefined;
  if (typeof token !== 'string' || token.length === 0 || !claims) return null;
  const { provider, sub, exp } = claims;
  if (typeof provider !== 'string' || typeof sub !== 'string') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return { token, provider, sub, expiresAt: exp };
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}
