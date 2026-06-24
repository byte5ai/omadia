/**
 * `/api/v1/admin/cli-backends` — backend for the "Subscription CLIs" admin page
 * (#309, Phase B). Reports which vendor LLM CLIs (Claude / Codex / Gemini) are
 * installed on the host and whether they are logged in, and drives the in-app
 * login flow, so a self-hoster can run agents on a subscription they already pay
 * for instead of a metered API key.
 *
 *  GET  /                       → { backends, generatedAt } (`?refresh=1` to bust cache)
 *  POST /:id/login/start        → { sessionId, verificationUrl } (spawns `claude auth login`)
 *  POST /:id/login/code         → { status, account? } (writes the pasted code to stdin)
 *  POST /:id/login/cancel       → { ok }
 *  POST /:id/logout             → { ok }
 *
 * Detection is read-only (never triggers a login or consumes quota). The login
 * endpoints spawn the official CLI with the API-key env scrubbed (subscription
 * path only). Auth is required — this exposes host capability, not a secret.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';

import { detectCliBackends } from '../platform/cliBackendDetector.js';
import {
  startCliLogin,
  submitCliCode,
  cancelCliLogin,
  cliLogout,
} from '../platform/cliAuthService.js';

export function createAdminCliBackendsRouter(): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const force = req.query['refresh'] === '1' || req.query['refresh'] === 'true';
    try {
      const snapshot = await detectCliBackends({ force });
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: 'detection_failed', message: errMessage(err) });
    }
  });

  router.post('/:id/login/start', async (req: Request, res: Response) => {
    try {
      const result = await startCliLogin(String(req.params['id']));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'login_start_failed', message: errMessage(err) });
    }
  });

  router.post('/:id/login/code', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; code?: unknown };
    if (typeof body.sessionId !== 'string' || typeof body.code !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'sessionId and code are required.' });
      return;
    }
    try {
      const result = await submitCliCode(body.sessionId, body.code);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'login_code_failed', message: errMessage(err) });
    }
  });

  router.post('/:id/login/cancel', (_req: Request, res: Response) => {
    cancelCliLogin();
    res.json({ ok: true });
  });

  router.post('/:id/logout', async (req: Request, res: Response) => {
    try {
      const result = await cliLogout(String(req.params['id']));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'logout_failed', message: errMessage(err) });
    }
  });

  return router;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
