import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type {
  PrivacyEgressConfig,
  PrivacyGuardService,
  PrivacyLiveTestResult,
} from '@omadia/plugin-api';

/**
 * Privacy-Shield v2 — Slice S-7 — Operator-UI backend.
 *
 * Read + write surface for the operator-facing privacy dashboard at
 * `web-ui/app/operator/privacy/page.tsx`. Mounted under `/api/v1` so the
 * routes are:
 *
 *   GET  /api/v1/operator/privacy/state        config + allowlist snapshot
 *   PUT  /api/v1/operator/privacy/overrides    replace operator-override list
 *   POST /api/v1/operator/privacy/live-test    run the detector pipeline
 *
 * Auth-gated by the parent mount (`requireAuth` on `/api/v1`). The single-
 * role model (`UserRole = 'admin'`) means every authenticated caller has
 * operator privileges; if a finer role model lands later, the gate goes
 * onto this router specifically rather than on a per-route basis.
 *
 * The fifth section of the operator UI (Recent-Hits-Audit) lives on a
 * separate v0.2.x slice — see Notion ticket `Privacy-Shield v2.x:
 * Receipt-Persistence + Recent-Hits-Audit-UI`. The receipts emitted by
 * `finalizeTurn` today are not persisted anywhere, so there is nothing
 * to surface here yet.
 *
 * Override-CRUD persistence semantics: the `PUT /overrides` call writes
 * into the privacy-guard service's in-process state. The change is
 * effective immediately for every subsequent turn, but it does NOT
 * survive a plugin re-activation or kernel restart — durable
 * persistence requires a plugin-config-update API that does not yet
 * exist. The UI shows a banner so the operator understands the
 * runtime-only semantics.
 */

const OverridePutBodySchema = z.object({
  terms: z.array(z.string()).max(500),
});

const LiveTestBodySchema = z.object({
  text: z.string().min(1).max(10_000),
});

export interface OperatorPrivacyRouterOptions {
  /** Late-bound service lookup so the router survives plugin
   *  re-activation. Returns undefined when no `privacy.redact@1`
   *  provider is installed — routes 503 in that case rather than
   *  surfacing a misleading empty state. */
  readonly getPrivacyGuard: () => PrivacyGuardService | undefined;
}

export function createOperatorPrivacyRouter(
  options: OperatorPrivacyRouterOptions,
): Router {
  const router = Router();

  function privacy(): PrivacyGuardService | undefined {
    return options.getPrivacyGuard();
  }

  router.get('/state', (_req: Request, res: Response) => {
    const svc = privacy();
    if (!svc) {
      res.status(503).json({
        error: 'privacy_provider_unavailable',
        message: 'No privacy.redact@1 provider is currently installed.',
      });
      return;
    }
    let egressConfig: PrivacyEgressConfig;
    try {
      egressConfig = svc.getEgressConfig();
    } catch (err) {
      console.warn('[operator-privacy] getEgressConfig failed:', err);
      egressConfig = { enabled: false, mode: 'mask', blockPlaceholderText: '' };
    }
    const allowlist = svc.getAllowlistSnapshot();
    res.json({
      egress: egressConfig,
      allowlist,
      // Detector list mirrors what the service is running with right now;
      // surfaces add-on plugin registrations (Ollama, Presidio) so the
      // operator can see which engines are active.
      detectors: ((): readonly string[] => {
        // listDetectors is on the internal interface; we re-cast lazily
        // because the operator UI is the only legitimate consumer.
        const internal = svc as unknown as {
          listDetectors?: () => ReadonlyArray<{ id: string }>;
        };
        return internal.listDetectors?.().map((d) => d.id) ?? [];
      })(),
      // Persistence semantics flag — UI uses it to show the runtime-only
      // banner on the override CRUD section.
      overridePersistsAcrossRestart: false,
    });
  });

  router.put('/overrides', (req: Request, res: Response) => {
    const svc = privacy();
    if (!svc) {
      res.status(503).json({
        error: 'privacy_provider_unavailable',
      });
      return;
    }
    const parsed = OverridePutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      svc.setOperatorOverrideTerms(parsed.data.terms);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[operator-privacy] setOperatorOverrideTerms failed:', err);
      res.status(500).json({ error: 'override_update_failed', message });
      return;
    }
    res.json({ allowlist: svc.getAllowlistSnapshot() });
  });

  router.post('/live-test', async (req: Request, res: Response) => {
    const svc = privacy();
    if (!svc) {
      res.status(503).json({
        error: 'privacy_provider_unavailable',
      });
      return;
    }
    const parsed = LiveTestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const result: PrivacyLiveTestResult = await svc.liveTest({
        text: parsed.data.text,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[operator-privacy] liveTest failed:', err);
      res.status(500).json({ error: 'live_test_failed', message });
    }
  });

  return router;
}
