/**
 * `/api/v1/admin/cli-backends` — backend for the "Subscription CLIs" admin page
 * (#309, Phase B). Reports which vendor LLM CLIs (Claude / Codex / Gemini) are
 * installed on the host and whether they are logged in, and drives the in-app
 * login flow, so a self-hoster can run agents on a subscription they already pay
 * for instead of a metered API key.
 *
 *  GET  /                       → { backends, generatedAt } (`?refresh=1` to bust cache)
 *  POST /:id/install            → 202 { status:'started' } | 200 { alreadyInstalled } (runtime npm install)
 *  GET  /:id/install/status     → { status: idle|running|succeeded|failed, … }
 *  POST /:id/login/start        → { sessionId, verificationUrl, codeEntry, status } (spawns `claude auth login`)
 *  GET  /:id/login/status       → { status, account?, error? } (poll the browser-callback flow)
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
  getActiveLogin,
} from '../platform/cliAuthService.js';
import {
  startCliInstall,
  getCliInstallStatus,
  UnknownCliBackendError,
  CliInstallConflictError,
  InvalidCliVersionError,
} from '../platform/cliInstallService.js';

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

  router.post('/:id/install', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { version?: unknown };
    if (body.version !== undefined && typeof body.version !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'version must be a string.' });
      return;
    }
    try {
      const result = await startCliInstall(String(req.params['id']), body.version);
      if (result.alreadyInstalled) {
        res.json({ status: 'succeeded', alreadyInstalled: true });
        return;
      }
      res.status(202).json({ status: 'started' });
    } catch (err) {
      if (err instanceof CliInstallConflictError) {
        res.status(409).json({ error: 'install_in_progress', message: err.message });
      } else if (err instanceof UnknownCliBackendError || err instanceof InvalidCliVersionError) {
        res.status(400).json({ error: 'bad_request', message: err.message });
      } else {
        res.status(500).json({ error: 'install_failed', message: errMessage(err) });
      }
    }
  });

  router.get('/:id/install/status', (req: Request, res: Response) => {
    res.json(getCliInstallStatus(String(req.params['id'])));
  });

  router.post('/:id/login/start', async (req: Request, res: Response) => {
    try {
      const result = await startCliLogin(String(req.params['id']));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: 'login_start_failed', message: errMessage(err) });
    }
  });

  // OM-73 — poll target for the browser-callback flow (newer CLI prints no
  // code, finishes on its own). Reports the live login status so the UI can
  // wait for `authorized` / `error` without a code field.
  router.get('/:id/login/status', (_req: Request, res: Response) => {
    const login = getActiveLogin();
    if (!login) {
      res.json({ status: 'idle' });
      return;
    }
    res.json({
      status: login.status,
      ...(login.account ? { account: login.account } : {}),
      ...(login.error ? { error: login.error } : {}),
    });
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
