import { Router } from 'express';
import type { Request, Response } from 'express';

import type {
  InstallConfigureResponse,
  InstallCreateResponse,
  InstallGetResponse,
} from '../api/admin-v1.js';
import type {
  InstallService} from '../plugins/installService.js';
import {
  InstallError
} from '../plugins/installService.js';
import type { OAuthBrokerService } from '../plugins/oauth/brokerService.js';
import { OAuthBrokerError } from '../plugins/oauth/brokerService.js';

interface InstallDeps {
  service: InstallService;
  /** Spec 005 — kernel OAuth broker. When present, mounts
   *  `GET /oauth/start` (operator-authed) + `GET /oauth/callback` (public,
   *  state-verified). Absent on cores running without the broker. */
  oauthBroker?: OAuthBrokerService;
}

/**
 * Install flow endpoints — first half of Slice 1.2.
 *
 * Contract: docs/harness-platform/api/admin-api.v1.ts, namespace `Install`.
 * Mounted at /api/v1/install.
 *
 * Scope:
 *   POST /plugins/:id                   — create a job, derive setup schema
 *   GET  /jobs/:id                      — poll job state
 *   POST /jobs/:id/configure            — submit setup form, activate
 *   POST /jobs/:id/cancel               — abort
 *   GET  /oauth/start                   — spec 005 broker: begin a flow
 *   GET  /oauth/callback                — spec 005 broker: finish a flow
 */
export function createInstallRouter(deps: InstallDeps): Router {
  const router = Router();

  if (deps.oauthBroker) {
    mountOAuthBroker(router, deps.service, deps.oauthBroker);
  }

  router.post('/plugins/:id', (req: Request, res: Response) => {
    withService(res, () => {
      const rawId = req.params['id'];
      const pluginId = typeof rawId === 'string' ? rawId : '';
      if (!pluginId) {
        res
          .status(400)
          .json({ code: 'install.invalid_plugin_id', message: 'missing id' });
        return;
      }
      const job = deps.service.create(pluginId);
      const body: InstallCreateResponse = { job };
      res.status(201).json(body);
    });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    withService(res, () => {
      const rawId = req.params['id'];
      const jobId = typeof rawId === 'string' ? rawId : '';
      if (!jobId) {
        res
          .status(400)
          .json({ code: 'install.invalid_job_id', message: 'missing id' });
        return;
      }
      const job = deps.service.get(jobId);
      const body: InstallGetResponse = { job };
      res.json(body);
    });
  });

  router.post('/jobs/:id/configure', async (req: Request, res: Response) => {
    await withServiceAsync(res, async () => {
      const rawId = req.params['id'];
      const jobId = typeof rawId === 'string' ? rawId : '';
      if (!jobId) {
        res
          .status(400)
          .json({ code: 'install.invalid_job_id', message: 'missing id' });
        return;
      }
      const incoming = req.body as { values?: unknown } | undefined;
      if (!incoming || typeof incoming.values !== 'object' || !incoming.values) {
        res.status(400).json({
          code: 'install.invalid_body',
          message: 'body must be { values: Record<string, unknown> }',
        });
        return;
      }
      const job = await deps.service.configure(
        jobId,
        incoming.values as Record<string, unknown>,
      );
      const body: InstallConfigureResponse = {
        job,
        agent_id: job.plugin_id,
      };
      res.json(body);
    });
  });

  router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
    withService(res, () => {
      const rawId = req.params['id'];
      const jobId = typeof rawId === 'string' ? rawId : '';
      if (!jobId) {
        res
          .status(400)
          .json({ code: 'install.invalid_job_id', message: 'missing id' });
        return;
      }
      deps.service.cancel(jobId);
      res.status(204).end();
    });
  });

  // Uninstall: removes an installed agent from registry + vault and (via
  // the onUninstall hook) detaches the domain tool from the orchestrator.
  // Idempotent enough: second call → 404.
  router.delete(
    '/installed/:id',
    async (req: Request, res: Response) => {
      await withServiceAsync(res, async () => {
        const rawId = req.params['id'];
        const agentId = typeof rawId === 'string' ? rawId : '';
        if (!agentId) {
          res.status(400).json({
            code: 'install.invalid_plugin_id',
            message: 'missing id',
          });
          return;
        }
        await deps.service.uninstall(agentId);
        res.status(204).end();
      });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Spec 005 — kernel OAuth broker routes
// ---------------------------------------------------------------------------

/**
 * `GET /oauth/start` (operator-authed via the mount's `requireAuth`) begins a
 * flow and 302-redirects the browser to the IdP. `GET /oauth/callback`
 * (public — see `publicPaths` in index.ts; self-secured by signed state)
 * finishes it and 302-redirects to the store page with a `connected` flag.
 *
 * Both endpoints ALWAYS redirect (never render JSON), because the browser
 * reaches them by top-level navigation — an error has to land on a page.
 */
function mountOAuthBroker(
  router: Router,
  service: InstallService,
  broker: OAuthBrokerService,
): void {
  router.get('/oauth/start', async (req: Request, res: Response) => {
    const fieldKey = strParam(req.query['fieldKey']);
    const jobId = strParam(req.query['jobId']);
    let pluginId = strParam(req.query['pluginId']);
    if (!pluginId && jobId) {
      try {
        pluginId = service.get(jobId).plugin_id;
      } catch {
        // job vanished — fall through to the missing-params redirect
      }
    }
    if (!pluginId || !fieldKey) {
      res.redirect(broker.redirectForError(pluginId, 'missing_params'));
      return;
    }
    try {
      const { redirectUrl } = await broker.start({
        pluginId,
        fieldKey,
        ...(jobId ? { jobId } : {}),
      });
      res.redirect(redirectUrl);
    } catch (err) {
      const reason =
        err instanceof OAuthBrokerError ? err.code : 'start_failed';
      if (!(err instanceof OAuthBrokerError)) {
        console.error('[oauth-broker] start failed:', err);
      }
      res.redirect(broker.redirectForError(pluginId, reason));
    }
  });

  router.get('/oauth/callback', async (req: Request, res: Response) => {
    const { redirectUrl } = await broker.callback({
      state: strParam(req.query['state']),
      code: strParam(req.query['code']),
      error: strParam(req.query['error']),
      errorDescription: strParam(req.query['error_description']),
    });
    res.redirect(redirectUrl);
  });
}

function strParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Small helpers — map InstallError to HTTP responses
// ---------------------------------------------------------------------------

function withService(res: Response, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    handleError(res, err);
  }
}

async function withServiceAsync(
  res: Response,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    handleError(res, err);
  }
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof InstallError) {
    const body: { code: string; message: string; details?: unknown } = {
      code: err.code,
      message: err.message,
    };
    if (err.details !== undefined) body.details = err.details;
    res.status(err.status).json(body);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ code: 'install.unexpected', message });
}
