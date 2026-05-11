import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AdminAuditLog } from '../auth/adminAuditLog.js';
import type {
  ProviderCatalog,
  ProviderRegistry,
} from '../auth/providerRegistry.js';
import type { PlatformSettingsStore } from '../auth/platformSettings.js';
import { SETTING_AUTH_ACTIVE_PROVIDERS } from '../auth/platformSettings.js';

interface AdminAuthDeps {
  registry: ProviderRegistry;
  catalog: ProviderCatalog;
  settings: PlatformSettingsStore;
  audit: AdminAuditLog;
}

interface ProviderRow {
  id: string;
  display_name: string;
  kind: 'password' | 'oidc';
  /** True when the env-var allowed it (= present in the catalog). */
  configured: boolean;
  /** True when currently active in the registry (= login-router will
   *  dispatch to it). */
  active: boolean;
}

/**
 * Auth-provider toggle endpoints (OB-50).
 *
 * D1=C "Hybrid" semantics:
 *   - the env-var `AUTH_PROVIDERS` is the **whitelist** (catalog) — the
 *     operator's static decision about which providers are allowed at
 *     all. Anything outside that list cannot be enabled, even by an
 *     admin with a valid session.
 *   - `platform_settings.auth.active_providers` is the **runtime
 *     override** — a subset of the catalog the admin has marked active.
 *     Empty / null = "all whitelisted providers active" (boot default).
 *
 * Toggle persists immediately and mutates the in-memory registry, so
 * the next /api/v1/auth/providers call reflects the new state without
 * a process restart.
 *
 * Self-lock-out: an admin can never disable the provider their own
 * session was minted by (`req.session.provider`) — without that gate
 * the admin would log out instantly and have no way back in unless
 * another active provider could authenticate them.
 */
export function createAdminAuthRouter(deps: AdminAuthDeps): Router {
  const router = Router();

  // ── GET /admin/auth/providers ─────────────────────────────────────────────
  router.get('/providers', async (_req: Request, res: Response) => {
    const rows: ProviderRow[] = deps.catalog.list().map((p) => ({
      id: p.id,
      display_name: p.displayName,
      kind: p.kind,
      configured: true,
      active: deps.registry.has(p.id),
    }));
    res.json({ providers: rows });
  });

  // ── POST /admin/auth/providers/:id/enable ────────────────────────────────
  router.post('/providers/:id/enable', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'admin_auth.missing_id' });
      return;
    }
    const provider = deps.catalog.get(id);
    if (!provider) {
      res.status(409).json({
        code: 'admin_auth.not_in_whitelist',
        message:
          'provider not present in AUTH_PROVIDERS env-var; an operator must add it before it can be enabled',
      });
      return;
    }
    if (deps.registry.has(id)) {
      res.json({ ok: true, already_active: true });
      return;
    }
    deps.registry.register(provider);
    await persistActive(deps);
    await deps.audit.record({
      actor: { email: req.session?.email },
      action: 'auth.provider_enable',
      target: `provider:${id}`,
      after: { id, active: true },
    });
    res.json({ ok: true });
  });

  // ── POST /admin/auth/providers/:id/disable ───────────────────────────────
  router.post('/providers/:id/disable', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'admin_auth.missing_id' });
      return;
    }
    if (!deps.catalog.has(id)) {
      // Disabling a non-whitelisted provider is a no-op — surface 404 so
      // the UI realises the catalog drifted under it.
      res.status(404).json({ code: 'admin_auth.unknown_provider' });
      return;
    }
    if (req.session?.provider === id) {
      res.status(409).json({
        code: 'admin_auth.self_lockout',
        message:
          'cannot disable the provider you are currently authenticated with',
      });
      return;
    }
    if (deps.registry.has(id) && deps.registry.size() === 1) {
      // Disabling the only active provider would leave no way to log in.
      res.status(409).json({
        code: 'admin_auth.last_active_provider',
        message:
          'cannot disable the last active provider — at least one must stay active',
      });
      return;
    }
    const removed = deps.registry.unregister(id);
    if (!removed) {
      res.json({ ok: true, already_inactive: true });
      return;
    }
    await persistActive(deps);
    await deps.audit.record({
      actor: { email: req.session?.email },
      action: 'auth.provider_disable',
      target: `provider:${id}`,
      after: { id, active: false },
    });
    res.json({ ok: true });
  });

  return router;
}

async function persistActive(deps: AdminAuthDeps): Promise<void> {
  const ids = deps.registry.list().map((p) => p.id);
  await deps.settings.set(SETTING_AUTH_ACTIVE_PROVIDERS, ids);
}

function readParam(req: Request, key: string): string | undefined {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}
