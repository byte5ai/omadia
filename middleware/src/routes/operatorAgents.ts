import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  attachAllPlugins,
  ConfigValidationError,
  type ChatSessionStore,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

import type { Plugin, PluginSetupField } from '../api/admin-v1.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';

/**
 * Phase B — minimal projection of a plugin's catalog entry surfaced to the
 * operator dashboard so it can render the B3a plugin multi-select (badge
 * + memory-scope + permissions overview) without a separate /store fetch.
 *
 * Filtered server-side to `install_state === 'installed'` so the UI does
 * not have to know which plugins are actually live.
 *
 * Note: the manifest's `setup.fields[]` lands on `Plugin.required_secrets`
 * (the field name is historical — pre-OB-29 every setup field was a
 * secret). Surfaced here as `setup_fields` so the B3c editor reads from
 * an intent-named property.
 */
interface AgentPluginCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: Plugin['kind'];
  readonly version: string;
  readonly multi_instance: boolean;
  readonly multi_instance_justification?: string;
  readonly privacy_class: 'strict' | 'default';
  readonly memory_reads: readonly string[];
  readonly memory_writes: readonly string[];
  readonly network_outbound: readonly string[];
  readonly setup_fields: readonly PluginSetupField[];
  /** Parent plugin ids this one inherits secrets/config from. Used by the
   *  operator dashboard to indent dependants under their parent in the
   *  plugin multi-select. */
  readonly depends_on: readonly string[];
}

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

const ResolveChannelSchema = z.object({
  channel_type: z.string().min(1).max(64),
  channel_key: z.string().min(1).max(500),
});

export interface OperatorAgentsRouterOptions {
  /** Late-bound lookups so the router survives orchestrator-plugin
   *  re-activation. Each returns undefined when the orchestratorRegistry
   *  service is not currently published (no DATABASE_URL / first boot
   *  before migrations) — routes 503 in that case. */
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly getChatSessionStore: () => ChatSessionStore | undefined;
  /** Phase B — kernel-owned plugin catalog + installed-registry pair.
   *  Used by `/plugin-catalog` (B3a multi-select), `/resolve-channel`
   *  (B3b routing tester surfaces installed channel-kind ids), and
   *  `/fallback/rehydrate` (B3d). Optional so the router stays usable
   *  in tests that build it with a bare config store. */
  readonly getPluginCatalog?: () => PluginCatalog | undefined;
  readonly getInstalledRegistry?: () => InstalledRegistry | undefined;
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

  // ── enabled list (chat-picker surface) ──────────────────────────────
  // Phase A — minimal-metadata list of enabled Agents for the chat
  // picker. Does NOT reveal plugin/binding internals; if a future role
  // split lands, this endpoint stays available to authenticated
  // operators while `GET /` becomes admin-only.
  router.get('/enabled', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const [agents, settings] = await Promise.all([
        live.store.listAgents(),
        live.store.getPlatformSettings(),
      ]);
      res.json({
        agents: agents
          .filter((a) => a.status === 'enabled')
          .map((a) => ({
            slug: a.slug,
            name: a.name,
            description: a.description,
            privacy_profile: a.privacyProfile,
            is_fallback: a.id === settings.fallbackAgentId,
          })),
        fallback_slug:
          agents.find((a) => a.id === settings.fallbackAgentId)?.slug ?? null,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

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

  // ── plugin catalog (B3a multi-select source) ────────────────────────
  // Returns the installed-plugin projection the dashboard needs to render
  // the multi-select: id, name, kind, multi_instance, memory scope,
  // network egress hosts, and the manifest `setup_fields` so B3c can
  // render typed per-(Agent × plugin) config forms.
  //
  // 503s when the kernel did not wire the catalog/installed-registry
  // getters (tests / minimal mounts). Filters reference-only plugins +
  // restricts to entries actually in the installed registry — the
  // operator can only attach what is live on the platform.
  router.get('/plugin-catalog', async (_req: Request, res: Response) => {
    const catalog = options.getPluginCatalog?.();
    const installed = options.getInstalledRegistry?.();
    if (!catalog || !installed) {
      res.status(503).json({
        error: 'plugin_catalog_unavailable',
        message:
          'pluginCatalog or installedRegistry not wired into the operator-agents router.',
      });
      return;
    }
    try {
      const installedIds = new Set(installed.list().map((e) => e.id));
      const entries: AgentPluginCatalogEntry[] = catalog
        .list()
        .filter((entry) => entry.plugin.is_reference_only !== true)
        .filter((entry) => installedIds.has(entry.plugin.id))
        .map((entry) => {
          const p = entry.plugin;
          const summary = p.permissions_summary;
          return {
            id: p.id,
            name: p.name,
            kind: p.kind,
            version: p.version,
            multi_instance: p.multi_instance !== false,
            ...(p.multi_instance_justification
              ? { multi_instance_justification: p.multi_instance_justification }
              : {}),
            privacy_class: p.privacy_class,
            memory_reads: summary?.memory_reads ?? [],
            memory_writes: summary?.memory_writes ?? [],
            network_outbound: summary?.network_outbound ?? [],
            setup_fields: p.required_secrets ?? [],
            depends_on: p.depends_on ?? [],
          } satisfies AgentPluginCatalogEntry;
        });
      res.json({ items: entries });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── routing tester (B3b) ────────────────────────────────────────────
  // "Which Agent handles teams/<key>?" — returns the same decision the
  // ChannelResolver would make for an inbound webhook, without invoking
  // it. Hits an explicit binding first, then the platform fallback.
  router.post('/resolve-channel', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = ResolveChannelSchema.parse(req.body);
      const match = live.registry.resolveByChannel(
        body.channel_type,
        body.channel_key,
      );
      if (!match) {
        res.json({
          matched: null,
          via: 'none',
          message:
            'no binding for this channel and no platform fallback is configured',
        });
        return;
      }
      const settings = await live.store.getPlatformSettings();
      const via =
        match.agent.id === settings.fallbackAgentId &&
        !match.bindings.some(
          (b) =>
            b.channelType === body.channel_type &&
            b.channelKey === body.channel_key,
        )
          ? 'fallback'
          : 'binding';
      res.json({
        matched: {
          slug: match.agent.slug,
          name: match.agent.name,
          privacy_profile: match.agent.privacyProfile,
        },
        via,
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── reset fallback to all installed plugins (B3d) ───────────────────
  // Re-runs the B1 catalog-attach against the CURRENT fallback Agent.
  // Consent-bearing — only invoked from an explicit operator button so
  // an operator who pruned the fallback is not silently re-granted
  // capabilities. Idempotent: upserts produce the same row shape.
  router.post('/fallback/rehydrate', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    const installed = options.getInstalledRegistry?.();
    if (!installed) {
      res.status(503).json({
        error: 'installed_registry_unavailable',
        message:
          'installedRegistry not wired into the operator-agents router.',
      });
      return;
    }
    try {
      const settings = await live.store.getPlatformSettings();
      if (!settings.fallbackAgentId) {
        res.status(409).json({
          error: 'no_fallback',
          message:
            'no fallback agent is currently configured — set one before rehydrating',
        });
        return;
      }
      const fallback = (await live.store.listAgents()).find(
        (a) => a.id === settings.fallbackAgentId,
      );
      if (!fallback) {
        res.status(404).json({ error: 'fallback_missing' });
        return;
      }
      // Skip `errored` entries (validateSnapshot would reject them anyway —
      // installedRegistry treats `errored` as un-installable until the
      // operator fixes the manifest). Include `inactive` so a plugin that
      // briefly stopped activating still ends up attached.
      const pluginIds = installed
        .list()
        .filter((e) => e.status !== 'errored')
        .map((e) => e.id);
      const attached = await attachAllPlugins(
        live.store,
        fallback.id,
        pluginIds,
      );
      await live.registry.reload();
      res.json({
        ok: true,
        slug: fallback.slug,
        attached,
        requested: pluginIds.length,
      });
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
