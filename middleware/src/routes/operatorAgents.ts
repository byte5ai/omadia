import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  ConfigValidationError,
  type ChatSessionStore,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

/**
 * Operator-UI backend for the multi-orchestrator runtime (US9 / T037).
 *
 * Read + write surface for the operator-facing Agents dashboard at
 * `web-ui/app/operator/agents/page.tsx`. Mounted under `/api/v1` so the
 * routes are:
 *
 *   GET    /api/v1/operator/agents                       list agents + bindings + plugins
 *   POST   /api/v1/operator/agents                       create agent
 *   PATCH  /api/v1/operator/agents/:slug                 update agent (name, privacy, status)
 *   DELETE /api/v1/operator/agents/:slug                 delete agent
 *   PUT    /api/v1/operator/agents/:slug/plugins         replace agent plugin set
 *   PUT    /api/v1/operator/agents/:slug/bindings        replace agent channel bindings
 *   PUT    /api/v1/operator/agents/fallback              set platform fallback (body: { slug | null })
 *   POST   /api/v1/operator/agents/:slug/drain           drain + clear session snapshots
 *   POST   /api/v1/operator/agents/:slug/kill            kill all sessions for the agent
 *   POST   /api/v1/operator/agents/reload                force a registry.reload() (manual hot-reload trigger)
 *
 * Auth-gated by the parent mount (`requireAuth` on `/api/v1`). All writes
 * go through `ConfigStore` — the change emits `agents_changed` via the
 * Postgres trigger, the reload bus picks it up, the registry diffs +
 * applies. The operator never has to "save & restart"; the next request
 * already sees the new config.
 */

const AgentCreateSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  privacy_profile: z.enum(['strict', 'default']).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
});

const AgentPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  privacy_profile: z.enum(['strict', 'default']).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
});

const AgentPluginsSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string().min(1).max(200),
      config: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    }),
  ),
});

const AgentBindingsSchema = z.object({
  bindings: z.array(
    z.object({
      channel_type: z.string().min(1).max(64),
      channel_key: z.string().min(1).max(500),
    }),
  ),
});

const FallbackSchema = z.object({
  slug: z.string().min(1).max(64).nullable(),
});

export interface OperatorAgentsRouterOptions {
  /** Late-bound lookups so the router survives orchestrator-plugin
   *  re-activation. Each returns undefined when the orchestratorRegistry
   *  service is not currently published (no DATABASE_URL / first boot
   *  before migrations) — routes 503 in that case. */
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly getChatSessionStore: () => ChatSessionStore | undefined;
}

export function createOperatorAgentsRouter(
  options: OperatorAgentsRouterOptions,
): Router {
  const router = Router();

  function svc(): {
    store: ConfigStore;
    registry: OrchestratorRegistry;
  } | undefined {
    const store = options.getConfigStore();
    const registry = options.getRegistry();
    if (!store || !registry) return undefined;
    return { store, registry };
  }

  function unavailable(res: Response): void {
    res.status(503).json({
      error: 'multi_orchestrator_unavailable',
      message:
        'orchestratorRegistry@1 is not published — DATABASE_URL must be set and the orchestrator plugin must be active.',
    });
  }

  function slugParam(req: Request, res: Response): string | undefined {
    const raw = req.params['slug'];
    if (typeof raw !== 'string' || raw.length === 0) {
      res.status(400).json({ error: 'invalid_slug' });
      return undefined;
    }
    return raw;
  }

  function badRequest(res: Response, err: unknown): void {
    if (err instanceof ConfigValidationError) {
      res.status(409).json({ error: 'config_validation', message: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'invalid_body',
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    console.error('[operator-agents]', err);
    res.status(500).json({ error: 'internal', message: (err as Error).message });
  }

  // ── list ────────────────────────────────────────────────────────────
  router.get('/', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const [agents, plugins, bindings, settings] = await Promise.all([
        live.store.listAgents(),
        live.store.listAllAgentPlugins(),
        live.store.listChannelBindings(),
        live.store.getPlatformSettings(),
      ]);
      const pluginsByAgent = groupBy(plugins, (p) => p.agentId);
      const bindingsByAgent = groupBy(bindings, (b) => b.agentId);
      const active = new Set(live.registry.list().map((a) => a.agent.id));
      res.json({
        agents: agents.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          privacy_profile: a.privacyProfile,
          status: a.status,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
          active: active.has(a.id),
          memory_scope:
            live.registry.get(a.slug)?.memoryScope.slice() ?? [],
          plugins: (pluginsByAgent.get(a.id) ?? []).map((p) => ({
            id: p.pluginId,
            config: p.config,
            enabled: p.enabled,
          })),
          bindings: (bindingsByAgent.get(a.id) ?? []).map((b) => ({
            channel_type: b.channelType,
            channel_key: b.channelKey,
          })),
        })),
        fallback_agent_id: settings.fallbackAgentId,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── create ──────────────────────────────────────────────────────────
  router.post('/', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentCreateSchema.parse(req.body);
      const created = await live.store.createAgent({
        slug: body.slug,
        name: body.name,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.privacy_profile
          ? { privacyProfile: body.privacy_profile }
          : {}),
        ...(body.status ? { status: body.status } : {}),
      });
      await live.registry.reload();
      res.status(201).json({ id: created.id, slug: created.slug });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── update ──────────────────────────────────────────────────────────
  router.patch('/:slug', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentPatchSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await live.store.updateAgent(existing.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.privacy_profile
          ? { privacyProfile: body.privacy_profile }
          : {}),
        ...(body.status ? { status: body.status } : {}),
      });
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── delete ──────────────────────────────────────────────────────────
  router.delete('/:slug', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await live.store.deleteAgent(existing.id);
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── replace plugins ─────────────────────────────────────────────────
  router.put('/:slug/plugins', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentPluginsSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const current = await live.store.listAgentPlugins(existing.id);
      const desired = new Set(body.plugins.map((p) => p.id));
      for (const p of current) {
        if (!desired.has(p.pluginId)) {
          await live.store.removeAgentPlugin(existing.id, p.pluginId);
        }
      }
      for (const p of body.plugins) {
        await live.store.upsertAgentPlugin(existing.id, {
          pluginId: p.id,
          ...(p.config ? { config: p.config } : {}),
          ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
        });
      }
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── replace bindings ────────────────────────────────────────────────
  router.put('/:slug/bindings', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = AgentBindingsSchema.parse(req.body);
      const slug = slugParam(req, res);
      if (!slug) return;
      const existing = await live.store.getAgentBySlug(slug);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const current = await live.store.listChannelBindingsForAgent(existing.id);
      const desired = new Set(
        body.bindings.map((b) => `${b.channel_type}|${b.channel_key}`),
      );
      for (const b of current) {
        if (!desired.has(`${b.channelType}|${b.channelKey}`)) {
          await live.store.removeChannelBinding(b.channelType, b.channelKey);
        }
      }
      for (const b of body.bindings) {
        // createChannelBinding throws ConfigValidationError on PK collision
        // (binding already owned by another agent) — let badRequest surface it.
        try {
          await live.store.createChannelBinding(existing.id, {
            channelType: b.channel_type,
            channelKey: b.channel_key,
          });
        } catch (err) {
          if (err instanceof ConfigValidationError) {
            const own = await live.store.resolveBinding(
              b.channel_type,
              b.channel_key,
            );
            if (own?.agentId === existing.id) continue;
          }
          throw err;
        }
      }
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── fallback ────────────────────────────────────────────────────────
  router.put('/fallback', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = FallbackSchema.parse(req.body);
      if (body.slug === null) {
        await live.store.setFallbackAgentId(null);
      } else {
        const target = await live.store.getAgentBySlug(body.slug);
        if (!target) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        await live.store.setFallbackAgentId(target.id);
      }
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── manual reload trigger ───────────────────────────────────────────
  router.post('/reload', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const plan = await live.registry.reload();
      res.json({
        ok: true,
        actions: plan.actions.length,
        platform_changed: plan.platformChanged,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── force-invalidate: drain ─────────────────────────────────────────
  router.post('/:slug/drain', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const sessionStore = options.getChatSessionStore();
    if (!sessionStore) {
      res.status(503).json({
        error: 'chat_session_store_unavailable',
        message: 'chatAgent@1 not published — chatSessionStore unavailable.',
      });
      return;
    }
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const affected = await live.registry.forceInvalidate(
        slug,
        'drain',
        sessionStore,
      );
      res.json({ ok: true, affected });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── force-invalidate: kill ──────────────────────────────────────────
  router.post('/:slug/kill', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const sessionStore = options.getChatSessionStore();
    if (!sessionStore) {
      res.status(503).json({
        error: 'chat_session_store_unavailable',
        message: 'chatAgent@1 not published — chatSessionStore unavailable.',
      });
      return;
    }
    try {
      const slug = slugParam(req, res);
      if (!slug) return;
      const affected = await live.registry.forceInvalidate(
        slug,
        'kill',
        sessionStore,
      );
      res.json({ ok: true, affected });
    } catch (err) {
      badRequest(res, err);
    }
  });

  return router;
}

function groupBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}
