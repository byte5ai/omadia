import { Router, json as expressJson } from 'express';
import type { Request, Response } from 'express';

import type { DevJobGate, DevJobGateStore, GateAnswer } from '../devplatform/pipeline/gateStore.js';

/**
 * Epic #470 W2 — the human-gate admin routes (spec §5).
 *
 * Two endpoints, both behind the admin session (this router is mounted behind
 * `requireAuth`, and re-reads the session as defence-in-depth):
 *   GET  /gates?status=waiting     — the operator inbox.
 *   POST /gates/:gateId/resolve    — approve/reject, holder-authorized.
 *
 * The authorization mirrors conductor's `resolveAwait` holder gate exactly,
 * because the failure it prevents is the same: a client-controlled payload
 * carrying only a gate id must NOT let any recipient resolve someone else's gate.
 * The holder set is resolved LIVE at resolve time (a moved role baton re-targets),
 * and a non-holder is 403, not a silent success.
 */

export interface DevPlatformGatesDeps {
  gates: DevJobGateStore;
  /** Live role→holders resolution (roleStore.resolve). */
  resolveRoleHolders: (roleKey: string) => Promise<string[]>;
  /** Enrich a gate for the inbox with its job + plan summary. */
  enrichGate?: (gate: DevJobGate) => Promise<Record<string, unknown>>;
  /** Called after a gate is approved — requeue the job at implement + append answers. */
  onApproved: (gate: DevJobGate, answers: GateAnswer[], resolvedBy: string) => Promise<void>;
  /** Called after a gate is rejected — cancel the job, record the note. */
  onRejected: (gate: DevJobGate, note: string | undefined, resolvedBy: string) => Promise<void>;
  log?: (msg: string) => void;
}

function callerSub(req: Request): string {
  const s = (req as { session?: { sub?: unknown } }).session;
  return typeof s?.sub === 'string' ? s.sub : '';
}

/** Canonicalize a sub the same way the rest of the platform does (lowercased). */
function canonical(sub: string): string {
  return sub.trim().toLowerCase();
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

export function createDevPlatformGatesRouter(deps: DevPlatformGatesDeps): Router {
  const router = Router();
  router.use(expressJson({ limit: '256kb' }));
  const log = deps.log ?? (() => {});

  /** The live holder set for a gate. */
  async function holdersOf(gate: DevJobGate): Promise<string[]> {
    const raw = gate.principalKind === 'role' ? await deps.resolveRoleHolders(gate.principalRef) : [gate.principalRef];
    return [...new Set(raw.map(canonical))];
  }

  // --- GET /gates?status=waiting -------------------------------------------
  router.get('/gates', (req: Request, res: Response): void => {
    void (async () => {
      if (!callerSub(req)) {
        sendError(res, 401, 'devplatform.unauthorized', 'no session');
        return;
      }
      const status = req.query['status'];
      // W2 surfaces the waiting inbox; other statuses are a simple filter later.
      if (status !== undefined && status !== 'waiting') {
        sendError(res, 400, 'devplatform.invalid_status', "only status=waiting is supported in W2");
        return;
      }
      const waiting = await deps.gates.listWaiting();
      const enriched = await Promise.all(
        waiting.map(async (gate) => ({
          id: gate.id,
          jobId: gate.jobId,
          questions: gate.questions,
          planArtifactId: gate.planArtifactId,
          planSha256: gate.planSha256,
          deadlineAt: gate.deadlineAt,
          createdAt: gate.createdAt,
          resolvedHolders: await holdersOf(gate),
          ...(deps.enrichGate ? await deps.enrichGate(gate) : {}),
        })),
      );
      res.json({ gates: enriched });
    })().catch((err) => {
      log(`[dev-platform] gate list failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendError(res, 500, 'devplatform.internal', 'internal error');
    });
  });

  // --- POST /gates/:gateId/resolve -----------------------------------------
  router.post('/gates/:gateId/resolve', (req: Request, res: Response): void => {
    void (async () => {
      const sub = callerSub(req);
      if (!sub) {
        sendError(res, 401, 'devplatform.unauthorized', 'no session');
        return;
      }
      const rawId = req.params['gateId'];
      const gateId = typeof rawId === 'string' ? rawId : '';
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body['approved'] !== 'boolean') {
        sendError(res, 400, 'devplatform.invalid_resolve', 'approved must be a boolean');
        return;
      }
      const approved = body['approved'];
      const note = typeof body['note'] === 'string' ? body['note'] : undefined;
      const answers: GateAnswer[] = Array.isArray(body['answers'])
        ? body['answers']
            .filter((a): a is { questionId: string; text: string } =>
              !!a && typeof a === 'object' &&
              typeof (a as Record<string, unknown>)['questionId'] === 'string' &&
              typeof (a as Record<string, unknown>)['text'] === 'string')
            .map((a) => ({ questionId: a.questionId, text: a.text }))
        : [];

      const gate = await deps.gates.get(gateId);
      if (!gate) {
        sendError(res, 404, 'devplatform.gate_not_found', 'no such gate');
        return;
      }

      // Holder authorization — LIVE, so a moved baton re-targets.
      const holders = await holdersOf(gate);
      if (!holders.includes(canonical(sub))) {
        sendError(res, 403, 'devplatform.gate_not_holder', 'not authorized to resolve this gate');
        return;
      }

      // Compare-and-swap: only a WAITING gate flips. A second concurrent resolver
      // gets null → 409, and only the winner advances the job.
      const resolved = await deps.gates.resolve(gateId, approved, canonical(sub), answers);
      if (!resolved) {
        sendError(res, 409, 'devplatform.gate_not_pending', 'gate is no longer waiting');
        return;
      }

      // Side effects run for the WINNER only (the CAS guarantees one).
      if (approved) {
        await deps.onApproved(resolved, answers, canonical(sub));
      } else {
        await deps.onRejected(resolved, note, canonical(sub));
      }
      res.json({ ok: true, jobId: resolved.jobId, status: resolved.status });
    })().catch((err) => {
      log(`[dev-platform] gate resolve failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendError(res, 500, 'devplatform.internal', 'internal error');
    });
  });

  return router;
}
