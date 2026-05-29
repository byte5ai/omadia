import { Router } from 'express';
import type { Request, Response } from 'express';

import type { RegistryClient } from '../plugins/registryClient.js';
import type { RegistryConfigStore } from '../plugins/registryConfigStore.js';
import { RegistryConfigError } from '../plugins/registryConfigStore.js';

export interface AdminRegistriesDeps {
  store: RegistryConfigStore;
  /** Live client refreshed after every mutation so changes apply without a
   *  process restart. */
  client: RegistryClient;
  log?: (msg: string) => void;
}

/**
 * Admin CRUD for the plugin registries Core pulls from (the "store sources").
 * Mounted at /api/v1/admin/registries behind requireAuth.
 *
 *   GET    /            list configured registries (tokens NEVER returned)
 *   POST   /            add { name, url, token? }
 *   PATCH  /:name       update { url?, token? }   (token:null clears it)
 *   DELETE /:name       remove
 *
 * The bearer `token` is write-only: it is stored in the encrypted vault and is
 * never echoed back — the listing only reports `has_token`. After each
 * mutation the live `RegistryClient` is reloaded from the store.
 */
export function createAdminRegistriesRouter(deps: AdminRegistriesDeps): Router {
  const router = Router();
  const log = deps.log ?? (() => {});

  const refresh = async (): Promise<void> => {
    deps.client.setRegistries(await deps.store.list());
  };

  router.get('/', async (_req: Request, res: Response) => {
    await withStore(res, async () => {
      const registries = await deps.store.listPublic();
      res.json({ registries });
    });
  });

  router.post('/', async (req: Request, res: Response) => {
    await withStore(res, async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = asString(body['name']);
      const url = asString(body['url']);
      if (!name || !url) {
        res.status(400).json({
          code: 'registry_config.missing_fields',
          message: 'name and url are required',
        });
        return;
      }
      const token = asString(body['token']);
      await deps.store.add(token ? { name, url, token } : { name, url });
      await refresh();
      log(`[registry] admin added registry '${name}' (${url})`);
      res.status(201).json({ ok: true });
    });
  });

  router.patch('/:name', async (req: Request, res: Response) => {
    await withStore(res, async () => {
      const name = readParam(req, 'name');
      if (!name) {
        res.status(400).json({ code: 'registry_config.missing_name' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { url?: string; token?: string | null } = {};
      if ('url' in body) patch.url = asString(body['url']);
      if ('token' in body) {
        // explicit null / "" clears the token; a string sets it
        patch.token = body['token'] === null ? null : asString(body['token']);
      }
      if (patch.url === undefined && patch.token === undefined) {
        res.status(400).json({
          code: 'registry_config.empty_patch',
          message: 'provide at least one of url, token',
        });
        return;
      }
      await deps.store.update(name, patch);
      await refresh();
      log(`[registry] admin updated registry '${name}'`);
      res.json({ ok: true });
    });
  });

  router.delete('/:name', async (req: Request, res: Response) => {
    await withStore(res, async () => {
      const name = readParam(req, 'name');
      if (!name) {
        res.status(400).json({ code: 'registry_config.missing_name' });
        return;
      }
      await deps.store.remove(name);
      await refresh();
      log(`[registry] admin removed registry '${name}'`);
      res.json({ ok: true });
    });
  });

  return router;
}

async function withStore(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof RegistryConfigError) {
      res.status(err.status).json({ code: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ code: 'registry_config.internal', message });
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function readParam(req: Request, key: string): string | undefined {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
