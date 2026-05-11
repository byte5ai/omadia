import { randomUUID } from 'node:crypto';
import type { Router, Request, Response } from 'express';

import type { BuilderAgent, BuilderEvent } from '../plugins/builder/builderAgent.js';
import type { DraftStore } from '../plugins/builder/draftStore.js';
import { BuilderModelRegistry } from '../plugins/builder/modelRegistry.js';
import type { BuilderModelId } from '../plugins/builder/types.js';
import type {
  BuilderTurnRingBuffer,
  StampedFrame,
} from '../plugins/builder/turnRingBuffer.js';

/**
 * Builder chat-surface routes.
 *
 *   POST /drafts/:id/turn
 *     → NDJSON stream of `BuilderFrame` (= `{ id, ...BuilderEvent }`).
 *       Phase B.4-3 baseline; B.5-3 added monotonic per-turn ids and a
 *       prefix `turn_started` event so a re-attaching client knows the
 *       turnId before it sees the user echo.
 *
 *   GET  /drafts/:id/turn/:turnId/resume?since=N
 *     → NDJSON stream of buffered frames with `id > N`, then live
 *       continuation if the turn is still running, then close. 404 if
 *       the turnId is unknown (never opened, or already GC'd).
 *
 * Stream framing follows the kernel's existing convention (`chat.ts`,
 * `builderPreview.ts`): one JSON object per line on `application/x-ndjson`.
 */

export interface BuilderChatDeps {
  draftStore: DraftStore;
  builderAgent: BuilderAgent;
  /**
   * Per-draft turn replay buffer. Optional — when omitted, POSTs still
   * emit framed events with monotonic ids but the resume endpoint stays
   * absent. Tests instantiate one explicitly to exercise the resume path.
   */
  turnRingBuffer?: BuilderTurnRingBuffer;
  /** Override the per-turn maximum NDJSON time-budget (ms). Default 900s. */
  turnTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 900_000;

/**
 * Mounts the builder chat routes onto an existing router. Idempotent against
 * the same router instance — caller must guarantee a single registration.
 */
export function registerBuilderChatRoutes(
  router: Router,
  deps: BuilderChatDeps,
): void {
  router.post(
    '/drafts/:id/turn',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
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

      const body = (req.body ?? {}) as { message?: unknown; model?: unknown };
      if (typeof body.message !== 'string' || body.message.trim().length === 0) {
        sendJson(res, 400, {
          code: 'builder.invalid_message',
          message: 'message must be a non-empty string',
        });
        return;
      }
      const message = body.message;

      let modelId: BuilderModelId;
      if (body.model === undefined) {
        const draft = await deps.draftStore.load(email, draftId);
        if (!draft) {
          sendJson(res, 404, {
            code: 'builder.draft_not_found',
            message: `kein Draft mit id '${draftId}'`,
          });
          return;
        }
        modelId = draft.codegenModel;
      } else if (
        typeof body.model === 'string' &&
        BuilderModelRegistry.has(body.model)
      ) {
        modelId = body.model;
      } else {
        sendJson(res, 400, {
          code: 'builder.invalid_model',
          message: `model muss einer von haiku|sonnet|opus sein`,
        });
        return;
      }

      const anthropicModelId =
        BuilderModelRegistry.get(modelId).anthropicModelId;

      // Open the NDJSON stream.
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let clientGone = false;
      res.on('close', () => {
        if (!res.writableEnded) clientGone = true;
      });

      const turnId = randomUUID();
      deps.turnRingBuffer?.start(turnId);

      // Local fallback id when no ring buffer is wired — keeps the wire
      // format identical so consumers don't need to special-case the
      // missing-buffer setup.
      let localId = 0;
      const stamp = (ev: BuilderEvent): StampedFrame => {
        if (deps.turnRingBuffer) return deps.turnRingBuffer.record(turnId, ev);
        localId += 1;
        return { id: localId, ev };
      };
      const write = (frame: StampedFrame): void => {
        if (clientGone) return;
        res.write(`${JSON.stringify(framePayload(frame))}\n`);
      };

      const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const turnDeadline = Date.now() + turnTimeoutMs;

      try {
        const iterator = deps.builderAgent.runTurn({
          draftId,
          userEmail: email,
          userMessage: message,
          modelChoice: anthropicModelId,
          turnId,
        });

        for await (const ev of iterator) {
          if (clientGone) break;
          if (Date.now() > turnDeadline) {
            write(
              stamp({
                type: 'error',
                code: 'builder.turn_timeout',
                message: `builder turn exceeded ${String(turnTimeoutMs)}ms`,
              }),
            );
            break;
          }
          // Theme E0 heartbeats are pure liveness pulses. They go stale on
          // resume (sinceLastActivityMs is wall-clock-now-relative) and
          // would only bloat the ring buffer (180 frames per 6-min turn at
          // a 2s cadence). Skip stamping/recording — emit raw, no id.
          if (ev.type === 'heartbeat') {
            if (!clientGone) {
              res.write(`${JSON.stringify(ev)}\n`);
            }
            continue;
          }
          write(stamp(ev));
        }
      } catch (err) {
        const message_ = err instanceof Error ? err.message : String(err);
        if (!clientGone) {
          console.error(
            `[builder/chat] turn failed for ${email}/${draftId}:`,
            err,
          );
          try {
            write(
              stamp({
                type: 'error',
                code: 'builder.chat_failed',
                message: message_,
              }),
            );
          } catch {
            // Buffer already finalised — nothing else we can do.
          }
        }
      } finally {
        deps.turnRingBuffer?.finalize(turnId);
        if (!res.writableEnded) res.end();
      }
    },
  );

  // ── GET /drafts/:id/turn/:turnId/resume ────────────────────────────────
  router.get(
    '/drafts/:id/turn/:turnId/resume',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
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
      const turnId = readTurnId(req);
      if (!turnId) {
        sendJson(res, 400, {
          code: 'builder.invalid_turn_id',
          message: 'missing :turnId',
        });
        return;
      }
      if (!deps.turnRingBuffer) {
        sendJson(res, 503, {
          code: 'builder.resume_unavailable',
          message: 'turn replay buffer is not wired',
        });
        return;
      }

      // Owner-scope guard: don't allow user A to peek at user B's turns
      // even if they happen to know the turnId. We rely on the draft id
      // being owner-scoped (DraftStore.load filters on email).
      const draft = await deps.draftStore.load(email, draftId);
      if (!draft) {
        sendJson(res, 404, {
          code: 'builder.draft_not_found',
          message: `kein Draft mit id '${draftId}'`,
        });
        return;
      }

      const since = parseSince(req.query['since']);

      const isFinal = deps.turnRingBuffer.isFinal(turnId);
      if (isFinal === null) {
        sendJson(res, 404, {
          code: 'builder.turn_not_found',
          message: `kein replay-buffer für turn '${turnId}' (unbekannt oder GC'd)`,
        });
        return;
      }

      // Open the resume stream.
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let clientGone = false;
      res.on('close', () => {
        if (!res.writableEnded) clientGone = true;
      });

      const writeFrame = (frame: StampedFrame): void => {
        if (clientGone) return;
        res.write(`${JSON.stringify(framePayload(frame))}\n`);
      };

      // Replay buffered frames first (deterministic, ordered).
      const buffered = deps.turnRingBuffer.snapshot(turnId, since) ?? [];
      let highestId = since;
      for (const frame of buffered) {
        if (clientGone) break;
        writeFrame(frame);
        if (frame.id > highestId) highestId = frame.id;
      }

      if (clientGone) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (deps.turnRingBuffer.isFinal(turnId)) {
        // Replay-only path — buffer is final, snapshot drained.
        res.end();
        return;
      }

      // Live-tail path — subscribe and forward frames as they land. Skip any
      // frames the snapshot already covered to avoid double-delivery in the
      // race window between snapshot() and subscribe().
      await new Promise<void>((resolve) => {
        if (!deps.turnRingBuffer) {
          resolve();
          return;
        }
        const unsubscribe = deps.turnRingBuffer.subscribe(
          turnId,
          (frame) => {
            if (clientGone) {
              unsubscribe();
              resolve();
              return;
            }
            if (frame.id <= highestId) return;
            highestId = frame.id;
            writeFrame(frame);
          },
          () => {
            unsubscribe();
            resolve();
          },
        );
        const onClose = (): void => {
          unsubscribe();
          resolve();
        };
        res.once('close', onClose);
      });

      if (!res.writableEnded) res.end();
    },
  );
}

// ---------------------------------------------------------------------------

/**
 * Wire frame is `{ id, ...event }` — flat shape so `BuilderTurnEvent` on the
 * frontend can keep its existing discriminated union and just gain an
 * `id: number` field on every variant.
 */
function framePayload(frame: StampedFrame): Record<string, unknown> {
  return { id: frame.id, ...frame.ev };
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readTurnId(req: Request): string | null {
  const raw = req.params['turnId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function parseSince(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}
