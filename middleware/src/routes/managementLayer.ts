/**
 * #2055 — the management layer's HTTP surface (spec 2042 §5.3, §5.6):
 *
 *  - `GET/PUT/DELETE /api/v1/operator/default-agents` — the default-agent
 *    table: entries for (user, channel), (user), (channel) and the instance,
 *    each naming an agent or `off`. An entry may only name an agent that is
 *    available there; a facilitator is never a default agent.
 *  - `GET /api/v1/agents/directory?channel=<type>` — the agents available to
 *    the signed-in user in that channel (pickers, directories), and what an
 *    unaddressed message from them would reach there.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { formatPrincipal, makePrincipal, parsePrincipal } from '@omadia/channel-sdk';
import {
  ADDRESSABLE_STATUS,
  assertArchetypeAllows,
  ChannelResolver,
  ConfigValidationError,
  ManagementRouter,
  archetypeOf,
  speakerFor,
  type ConfigStore,
  type DefaultAgentEntryRow,
  type OrchestratorRegistry,
  type RoutingAgentRecord,
} from '@omadia/orchestrator';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import { respondFacilitatorRefusal } from '../platform/facilitatorGuard.js';

export interface ManagementLayerRouterOptions {
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly audit?: (entry: AuditEntryInput) => Promise<void>;
}

const DefaultEntrySchema = z.object({
  /** `user:<id>`, or null for every user. */
  principal: z.string().regex(/^user:.+/).max(320).nullable(),
  /** A channel type, or null for every channel. */
  channel_type: z.string().min(1).max(64).nullable(),
  /** The agent, or null for `off`. */
  agent_slug: z.string().min(1).max(64).nullable(),
});

const DirectoryQuerySchema = z.object({
  channel: z.string().min(1).max(64).default('web'),
});

interface Live {
  readonly store: ConfigStore;
  readonly registry: OrchestratorRegistry;
}

function live(options: ManagementLayerRouterOptions): Live | undefined {
  const store = options.getConfigStore();
  const registry = options.getRegistry();
  return store && registry ? { store, registry } : undefined;
}

function unavailable(res: Response): void {
  res.status(503).json({
    error: 'multi_orchestrator_unavailable',
    message: 'orchestratorRegistry / configStore not available — DATABASE_URL must be set and the agent runtime must be active.',
  });
}

function badRequest(res: Response, err: unknown): void {
  // #2060 — a facilitator's omissions answer with their stable contract.
  if (respondFacilitatorRefusal(res, err)) return;
  if (err instanceof ConfigValidationError) {
    res.status(409).json({ error: 'config_validation', message: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: 'invalid_body',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) });
}

function entryDto(entry: DefaultAgentEntryRow, registry: OrchestratorRegistry): Record<string, unknown> {
  const agent = entry.agentId ? registry.routingView().agentById(entry.agentId) : undefined;
  return {
    id: entry.id,
    principal: entry.principal,
    channel_type: entry.channelType,
    off: entry.agentId === null,
    agent_slug: agent?.slug ?? null,
    agent_name: agent?.displayName ?? null,
    // `deleted` / `disabled`: messages there get a notice naming the agent.
    agent_status: agent ? (agent.deleted ? 'deleted' : agent.status) : null,
    updated_by: entry.updatedBy,
    updated_at: entry.updatedAt.toISOString(),
  };
}

/**
 * Why an entry may not name this agent, or `undefined` when it may (spec
 * §5.3: an entry names only an agent available where it applies).
 */
export function defaultEntryRefusal(
  agent: RoutingAgentRecord,
  entry: { readonly principal: string | null; readonly channelType: string | null },
  router: ManagementRouter,
): string | undefined {
  if (agent.deleted) return 'agent_deleted';
  if (agent.status !== ADDRESSABLE_STATUS) return 'agent_disabled';
  if (!agent.defaultable) return 'archetype_not_default';
  if (entry.channelType === null) {
    if (agent.availableChannels !== null) return 'agent_not_available_in_every_channel';
  } else if (agent.availableChannels !== null && !agent.availableChannels.includes(entry.channelType)) {
    return 'agent_not_available_in_channel';
  }
  if (entry.principal === null) {
    return agent.availableToEveryone ? undefined : 'agent_not_available_to_everyone';
  }
  // The channel was checked above; with no channel type every channel is open.
  return router.isAvailable(agent, { channelType: entry.channelType ?? '', principal: entry.principal })
    ? undefined
    : 'agent_not_available_to_user';
}

function canonicalUser(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = parsePrincipal(raw);
  if (!parsed || parsed.kind !== 'user') throw new ConfigValidationError(`invalid user principal '${raw}'`);
  return formatPrincipal(parsed);
}

export function createOperatorDefaultAgentsRouter(options: ManagementLayerRouterOptions): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    const svc = live(options);
    if (!svc) return unavailable(res);
    try {
      const entries = await svc.store.routing.listDefaultEntries();
      res.json({ entries: entries.map((e) => entryDto(e, svc.registry)) });
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.put('/', async (req: Request, res: Response) => {
    const svc = live(options);
    if (!svc) return unavailable(res);
    try {
      const body = DefaultEntrySchema.parse(req.body);
      const principal = canonicalUser(body.principal);
      let agentId: string | null = null;
      if (body.agent_slug !== null) {
        const view = svc.registry.routingView();
        const agent = view.agentBySlug(body.agent_slug);
        if (!agent) {
          res.status(404).json({ error: 'agent_not_found', slug: body.agent_slug });
          return;
        }
        // #2060 — a facilitator is never a default agent; refused with the
        // stable omission contract before any other check.
        const row = await svc.store.getAgentBySlug(agent.slug);
        if (row) assertArchetypeAllows(row, 'default_agent');
        const refusal = defaultEntryRefusal(
          agent,
          { principal, channelType: body.channel_type },
          new ManagementRouter({ view }),
        );
        if (refusal) {
          res.status(409).json({ error: refusal, slug: agent.slug });
          return;
        }
        agentId = agent.id;
      }
      const actor = auditActorFromRequest(req);
      const previous = (await svc.store.routing.listDefaultEntries()).find(
        (e) => e.principal === principal && e.channelType === body.channel_type,
      );
      const entry = await svc.store.routing.upsertDefaultEntry({
        principal,
        channelType: body.channel_type,
        agentId,
        updatedBy: actor.id ?? actor.email ?? null,
      });
      await options.audit?.({
        actor,
        action: 'agent.default_entry.set',
        target: `${principal ?? '*'}@${body.channel_type ?? '*'}`,
        before: previous ? { agent_id: previous.agentId, off: previous.agentId === null } : null,
        after: { agent_slug: body.agent_slug, off: agentId === null },
      });
      await svc.registry.reload();
      res.json({ ok: true, entry: entryDto(entry, svc.registry) });
    } catch (err) {
      badRequest(res, err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const svc = live(options);
    if (!svc) return unavailable(res);
    try {
      const id = z.string().uuid().parse(req.params['id']);
      const removed = await svc.store.routing.deleteDefaultEntry(id);
      if (!removed) {
        // Unknown, or the instance entry (it can be set to `off`, never removed).
        res.status(404).json({ error: 'not_found_or_instance_entry' });
        return;
      }
      await options.audit?.({
        actor: auditActorFromRequest(req),
        action: 'agent.default_entry.delete',
        target: id,
      });
      await svc.registry.reload();
      res.json({ ok: true });
    } catch (err) {
      badRequest(res, err);
    }
  });

  return router;
}

/** The signed-in user as a principal (e-mail first, as channels name people). */
export function requestPrincipal(req: Request): string | undefined {
  const ref = req.session?.email || req.session?.sub;
  const principal = ref ? makePrincipal('user', ref) : undefined;
  return principal ? formatPrincipal(principal) : undefined;
}

export function createAgentDirectoryRouter(options: ManagementLayerRouterOptions): Router {
  const router = Router();

  router.get('/directory', (req: Request, res: Response) => {
    const svc = live(options);
    if (!svc) return unavailable(res);
    try {
      const { channel } = DirectoryQuerySchema.parse(req.query);
      const principal = requestPrincipal(req);
      const view = svc.registry.routingView();
      const router = new ManagementRouter({ view });
      const request = { channelType: channel, ...(principal ? { principal } : {}) };
      const agents = view
        .liveAgents()
        .filter((a) => a.status === ADDRESSABLE_STATUS && a.bindable && router.isAvailable(a, request))
        .map((a) => {
          const row = svc.registry.getById(a.id)?.agent;
          const speaker = row ? speakerFor(row) : undefined;
          return {
            // The agent id: what explicit addressing by id (`resolveAgent`,
            // a canvas turn's `metadata.agentId`) takes.
            id: a.id,
            slug: a.slug,
            display_name: a.displayName,
            short_description: row?.identityShortDescription ?? null,
            avatar_url: speaker?.avatarUrl ?? null,
            archetype: row ? archetypeOf(row) : null,
          };
        })
        .sort((x, y) => x.display_name.localeCompare(y.display_name));
      // What an unaddressed message from this user in this channel reaches:
      // the default agent, or the notice (`off`, unavailable, …).
      const unaddressed = new ChannelResolver({ registry: svc.registry }).resolve(
        channel,
        `directory:${principal ?? 'anonymous'}`,
        principal ? { principal } : {},
      );
      res.json({
        channel,
        agents,
        default_agent:
          unaddressed.decision === 'bound' && unaddressed.agent
            ? { slug: unaddressed.agent.agent.slug }
            : { slug: null, notice: unaddressed.notice?.code ?? 'no_agent' },
      });
    } catch (err) {
      badRequest(res, err);
    }
  });

  return router;
}
