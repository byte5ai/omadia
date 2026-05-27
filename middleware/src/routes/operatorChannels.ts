import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  ConfigValidationError,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

import type { ChannelDirectoryRegistry } from '../channels/channelDirectoryRegistry.js';

/**
 * Operator-facing channel dashboard (`/operator/channels`).
 *
 * Inverts the perspective of the per-Agent bindings editor: instead of
 * "this Agent attaches these bindings", show "this channel-key is handled
 * by which Agent". Operators think in terms of "my Teams bot routes to
 * agent X", not "agent X has these cryptic keys attached"; this surface
 * matches that mental model.
 *
 *   GET    /api/v1/operator/channels             list known channels + current binding
 *   PUT    /api/v1/operator/channels/binding     set / replace a single binding
 *   DELETE /api/v1/operator/channels/binding     drop a single binding
 *
 * The directory side is read-only — it comes from each channel plugin's
 * `ChannelKeyDirectory.listKeys()` contribution. The binding side
 * mutates `channel_bindings` through the same `ConfigStore` that the
 * per-Agent editor uses, so the registry's hot-reload pipeline picks
 * the change up automatically (no separate reload trigger needed).
 */

const SetBindingSchema = z.object({
  channel_type: z.string().min(1).max(64),
  channel_key: z.string().min(1).max(500),
  /** null = clear the binding (route falls back to platform fallback). */
  agent_slug: z.string().min(1).max(64).nullable(),
});

const DeleteBindingSchema = z.object({
  channel_type: z.string().min(1).max(64),
  channel_key: z.string().min(1).max(500),
});

export interface OperatorChannelsRouterOptions {
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly getDirectoryRegistry: () => ChannelDirectoryRegistry | undefined;
}

interface OperatorChannelDto {
  readonly channel_type: string;
  readonly channel_key: string;
  readonly label: string;
  readonly hint?: string;
  readonly origin_plugin_id: string;
  readonly bound_agent_slug: string | null;
  /** True when this row is only known from the binding table (the channel
   *  plugin no longer lists it, e.g. uninstalled / config changed). The
   *  dashboard surfaces these as "stale binding" so the operator can
   *  decide whether to clear them. */
  readonly stale: boolean;
}

export function createOperatorChannelsRouter(
  options: OperatorChannelsRouterOptions,
): Router {
  const router = Router();

  function svc(): {
    store: ConfigStore;
    registry: OrchestratorRegistry;
    directory: ChannelDirectoryRegistry;
  } | undefined {
    const store = options.getConfigStore();
    const registry = options.getRegistry();
    const directory = options.getDirectoryRegistry();
    if (!store || !registry || !directory) return undefined;
    return { store, registry, directory };
  }

  function unavailable(res: Response): void {
    res.status(503).json({
      error: 'multi_orchestrator_unavailable',
      message:
        'orchestratorRegistry / configStore / channelDirectoryRegistry not all available — DATABASE_URL must be set and the orchestrator plugin must be active.',
    });
  }

  function badRequest(res: Response, err: unknown): void {
    if (err instanceof ConfigValidationError) {
      res
        .status(409)
        .json({ error: 'config_validation', message: err.message });
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
    console.error('[operator-channels]', err);
    res
      .status(500)
      .json({ error: 'internal', message: (err as Error).message });
  }

  // ── list ────────────────────────────────────────────────────────────
  // Joins the channel-plugin directories with the current
  // `channel_bindings` table. Rows are sorted by channel_type then label.
  router.get('/', async (_req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const [directoryEntries, agents, bindings, settings] = await Promise.all([
        live.directory.listAll(),
        live.store.listAgents(),
        live.store.listChannelBindings(),
        live.store.getPlatformSettings(),
      ]);

      const agentById = new Map(agents.map((a) => [a.id, a]));
      const bindingByKey = new Map<string, { agentId: string }>();
      for (const b of bindings) {
        bindingByKey.set(`${b.channelType}:${b.channelKey}`, {
          agentId: b.agentId,
        });
      }

      const seen = new Set<string>();
      const channels: OperatorChannelDto[] = directoryEntries.map((entry) => {
        const k = `${entry.channelType}:${entry.key}`;
        seen.add(k);
        const bound = bindingByKey.get(k);
        const slug = bound ? agentById.get(bound.agentId)?.slug ?? null : null;
        return {
          channel_type: entry.channelType,
          channel_key: entry.key,
          label: entry.label,
          ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
          origin_plugin_id: entry.originPluginId,
          bound_agent_slug: slug,
          stale: false,
        };
      });

      // Surface bindings whose key is NOT in any directory — the channel
      // plugin no longer reports it (uninstalled / config drift). The
      // operator should decide whether to clear them.
      for (const b of bindings) {
        const k = `${b.channelType}:${b.channelKey}`;
        if (seen.has(k)) continue;
        const slug = agentById.get(b.agentId)?.slug ?? null;
        channels.push({
          channel_type: b.channelType,
          channel_key: b.channelKey,
          label: b.channelKey,
          origin_plugin_id: '',
          bound_agent_slug: slug,
          stale: true,
        });
      }

      const fallback_slug =
        agents.find((a) => a.id === settings.fallbackAgentId)?.slug ?? null;

      res.json({
        channels,
        agents: agents
          .filter((a) => a.status === 'enabled')
          .map((a) => ({ slug: a.slug, name: a.name })),
        fallback_slug,
        directory_types: live.directory.types(),
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── set / replace one binding ───────────────────────────────────────
  router.put('/binding', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = SetBindingSchema.parse(req.body);
      // Find the current binding (if any) for this (type, key) — single
      // PUT either re-points an existing binding or creates a new row.
      const all = await live.store.listChannelBindings();
      const existing = all.find(
        (b) =>
          b.channelType === body.channel_type &&
          b.channelKey === body.channel_key,
      );

      if (body.agent_slug === null) {
        if (existing) {
          await live.store.removeChannelBinding(
            body.channel_type,
            body.channel_key,
          );
        }
        await live.registry.reload();
        res.json({ ok: true, cleared: !!existing });
        return;
      }

      const target = await live.store.getAgentBySlug(body.agent_slug);
      if (!target) {
        res.status(404).json({ error: 'agent_not_found', slug: body.agent_slug });
        return;
      }

      if (existing && existing.agentId === target.id) {
        // Idempotent re-binding to the same agent — no write, no reload.
        res.json({ ok: true, unchanged: true });
        return;
      }

      // Remove + add. We don't have a direct "move binding" primitive in
      // the ConfigStore; the trigger fires on each row change anyway.
      if (existing) {
        await live.store.removeChannelBinding(
          body.channel_type,
          body.channel_key,
        );
      }
      await live.store.createChannelBinding(target.id, {
        channelType: body.channel_type,
        channelKey: body.channel_key,
      });
      await live.registry.reload();
      res.json({ ok: true, bound_to: target.slug });
    } catch (err) {
      badRequest(res, err);
    }
  });

  // ── drop one binding ────────────────────────────────────────────────
  router.delete('/binding', async (req: Request, res: Response) => {
    const live = svc();
    if (!live) return unavailable(res);
    try {
      const body = DeleteBindingSchema.parse(req.body);
      await live.store.removeChannelBinding(
        body.channel_type,
        body.channel_key,
      );
      await live.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  return router;
}
