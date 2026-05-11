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

interface InstallDeps {
  service: InstallService;
}

/**
 * Install flow endpoints — first half of Slice 1.2.
 *
 * Contract: docs/harness-platform/api/admin-api.v1.ts, namespace `Install`.
 * Mounted at /api/v1/install.
 *
 * Slice 1.2a scope:
 *   POST /plugins/:id                   — create a job, derive setup schema
 *   GET  /jobs/:id                      — poll job state
 *   POST /jobs/:id/configure            — submit setup form, activate
 *   POST /jobs/:id/cancel               — abort
 *
 * Out of scope (→ 1.2b / 1.2c):
 *   GET  /jobs/:id/stream (SSE progress)
 *   POST /oauth/start + /oauth/callback
 *   Persistent job log beyond the process lifetime
 */
export function createInstallRouter(deps: InstallDeps): Router {
  const router = Router();

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

  // Uninstall: entfernt einen installierten Agent wieder aus Registry + Vault
  // und löst (via onUninstall-Hook) das Domain-Tool aus dem Orchestrator.
  // Idempotent genug: zweiter Call → 404.
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
