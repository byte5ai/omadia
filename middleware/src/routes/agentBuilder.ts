/**
 * Agent Builder canvas — REST surface (P1/P2).
 *
 * Backs the editable `/admin/builder` canvas. Mounted at `/api/v1/operator`
 * (after the operator-agents router, so the `/agents/:slug/graph|subagents|…`
 * subpaths fall through to here). Every write routes through `ConfigStore` /
 * `AgentGraphStore`, whose triggers fire the `agents_changed` notify → the
 * registry hot-reloads; we also call `registry.reload()` inline so the
 * response already reflects the applied diff.
 *
 * Node-id scheme (must match web-ui `graphMapping.nodeId`):
 *   channel:<type>:<key> · agent:<id> · subagent:<id> · skill:<id> ·
 *   tool:<ref> · mcp:<id> · schedule:<id>
 */

import {
  ConfigValidationError,
  type AgentGraphStore,
  type AgentRow,
  type ConfigStore,
  type McpServerConfig,
  type McpServerRow,
  type OrchestratorRegistry,
  type ScheduleRow,
  type SkillRow,
  type SubAgentRow,
  type ToolGrantRow,
} from '@omadia/orchestrator';
import { McpManager } from '@omadia/orchestrator';
import { Router, type Request, type Response } from 'express';

export interface AgentBuilderRouterOptions {
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getGraphStore: () => AgentGraphStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  /** The orchestrator's single configured LLM provider id (live-read from the
   *  installed `@omadia/orchestrator` config, default `anthropic`). Scopes
   *  per-Agent / sub-agent model writes to this provider so a cross-provider
   *  pick is rejected instead of silently dropped at build (issue #296). */
  readonly getActiveProvider?: () => string | undefined;
}

interface Live {
  readonly config: ConfigStore;
  readonly graph: AgentGraphStore;
  readonly registry: OrchestratorRegistry | undefined;
}

export function createAgentBuilderRouter(
  options: AgentBuilderRouterOptions,
): Router {
  const router = Router();
  const mcp = new McpManager();

  function live(res: Response): Live | undefined {
    const config = options.getConfigStore();
    const graph = options.getGraphStore();
    if (!config || !graph) {
      res.status(503).json({ error: 'multi_orchestrator_unavailable' });
      return undefined;
    }
    return { config, graph, registry: options.getRegistry() };
  }

  async function agentOr404(
    l: Live,
    slug: string,
    res: Response,
  ): Promise<AgentRow | undefined> {
    const agent = await l.config.getAgentBySlug(slug);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found', slug });
      return undefined;
    }
    return agent;
  }

  // ── GET graph ──────────────────────────────────────────────────────────
  router.get('/agents/:slug/graph', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agent = await agentOr404(l, str(req.params.slug), res);
      if (!agent) return;
      const [bindings, subAgents, skills, grants, servers, schedules] =
        await Promise.all([
          l.config.listChannelBindingsForAgent(agent.id),
          l.graph.listAllSubAgents(),
          l.graph.listSkills(),
          l.graph.listAllToolGrants(),
          l.graph.listMcpServers(),
          l.graph.listSchedulesForAgent(agent.id),
        ]);
      res.json(
        assembleGraph(agent, bindings, subAgents, skills, grants, servers, schedules, l.registry),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // ── edges ──────────────────────────────────────────────────────────────
  router.post('/agents/:slug/graph/edges', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agent = await agentOr404(l, str(req.params.slug), res);
      if (!agent) return;
      const edge = await createEdge(l, agent, req.body ?? {});
      const diff = await reload(l);
      res.json({ edge, diff });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete(
    '/agents/:slug/graph/edges/:id',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const kind = str(req.query['kind']);
        await deleteEdge(l, decodeURIComponent(str(req.params.id)), kind);
        await reload(l);
        res.status(204).end();
      } catch (err) {
        fail(res, err);
      }
    },
  );

  // ── sub-agents ───────────────────────────────────────────────────────────
  router.post('/agents/:slug/subagents', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agent = await agentOr404(l, str(req.params.slug), res);
      if (!agent) return;
      const b = req.body ?? {};
      const row = await l.graph.createSubAgent(
        {
          parentAgentId: agent.id,
          name: String(b.name ?? '').trim(),
          skillId: b.skillId ?? null,
          model: b.model ?? null,
          maxTokens: b.maxTokens ?? null,
          maxIterations: b.maxIterations ?? null,
          systemPromptOverride: b.systemPromptOverride ?? null,
          status: b.status ?? 'enabled',
          position: b.position ?? null,
        },
        options.getActiveProvider?.(),
      );
      await reload(l);
      res.json(subAgentNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch(
    '/agents/:slug/subagents/:id',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const row = await l.graph.updateSubAgent(
          str(req.params.id),
          req.body ?? {},
          options.getActiveProvider?.(),
        );
        await reload(l);
        res.json(subAgentNode(row));
      } catch (err) {
        fail(res, err);
      }
    },
  );

  router.delete(
    '/agents/:slug/subagents/:id',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        await l.graph.deleteSubAgent(str(req.params.id));
        await reload(l);
        res.status(204).end();
      } catch (err) {
        fail(res, err);
      }
    },
  );

  // ── model routing + positions ────────────────────────────────────────────
  router.patch(
    '/agents/:slug/model-routing',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const agent = await agentOr404(l, str(req.params.slug), res);
        if (!agent) return;
        const routing = (req.body ?? {}).modelRouting ?? null;
        const updated = await l.config.setModelRouting(
          agent.id,
          routing,
          options.getActiveProvider?.(),
        );
        await reload(l);
        res.json(agentNode(updated, l.registry));
      } catch (err) {
        fail(res, err);
      }
    },
  );

  router.patch('/agents/:slug/positions', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agent = await agentOr404(l, str(req.params.slug), res);
      if (!agent) return;
      const b = req.body ?? {};
      if (b.agent) await l.config.setCanvasPosition(agent.id, b.agent);
      for (const s of b.subAgents ?? []) {
        await l.graph.updateSubAgent(s.id, { position: s.position });
      }
      for (const c of b.channels ?? []) {
        await l.config.setChannelBindingPosition(c.channelType, c.channelKey, c.position);
      }
      res.status(204).end(); // positions are cosmetic — no reload needed
    } catch (err) {
      fail(res, err);
    }
  });

  // ── skills (global) ────────────────────────────────────────────────────────
  router.get('/skills', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const skills = (await l.graph.listSkills()).map(skillNode);
      res.json({ skills });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/skills', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const b = req.body ?? {};
      const row = await l.graph.upsertSkill({
        slug: String(b.slug ?? '').trim(),
        name: String(b.name ?? '').trim(),
        description: b.description ?? null,
        body: b.body ?? '',
      });
      res.json(skillNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/skills/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const row = await l.graph.updateSkill(str(req.params.id), req.body ?? {});
      await reload(l);
      res.json(skillNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/skills/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      await l.graph.deleteSkill(str(req.params.id));
      await reload(l);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // ── mcp servers ───────────────────────────────────────────────────────────
  router.get('/mcp-servers', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      res.json({ servers: (await l.graph.listMcpServers()).map(mcpNode) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/mcp-servers', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const b = req.body ?? {};
      const row = await l.graph.createMcpServer({
        name: String(b.name ?? '').trim(),
        transport: b.transport,
        endpoint: b.endpoint ?? null,
        status: b.status ?? 'enabled',
      });
      res.json(mcpNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/mcp-servers/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      await l.graph.deleteMcpServer(str(req.params.id));
      await reload(l);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/mcp-servers/:id/discover', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const servers = await l.graph.listMcpServers();
      const row = servers.find((s) => s.id === str(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      const tools = await mcp.listTools(toMcpConfig(row));
      await l.graph.setMcpDiscoveredTools(row.id, tools);
      const updated = (await l.graph.listMcpServers()).find((s) => s.id === row.id);
      res.json(updated ? mcpNode(updated) : mcpNode(row));
    } catch (err) {
      // Discovery talks to an external process — report as a 502, not a 5xx crash.
      res.status(502).json({ error: 'mcp_discover_failed', message: msg(err) });
    }
  });

  // ── schedules ─────────────────────────────────────────────────────────────
  router.get('/agents/:slug/schedules', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agent = await agentOr404(l, str(req.params.slug), res);
      if (!agent) return;
      const schedules = (await l.graph.listSchedulesForAgent(agent.id)).map(
        scheduleNode,
      );
      res.json({ schedules });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/agents/:slug/schedules', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agent = await agentOr404(l, str(req.params.slug), res);
      if (!agent) return;
      const b = req.body ?? {};
      const row = await l.graph.createSchedule({
        agentId: agent.id,
        cron: String(b.cron ?? '').trim(),
        timezone: b.timezone ?? 'UTC',
        payload: b.payload ?? {},
        status: b.status ?? 'enabled',
      });
      res.json(scheduleNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete(
    '/agents/:slug/schedules/:id',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        await l.graph.deleteSchedule(str(req.params.id));
        res.status(204).end();
      } catch (err) {
        fail(res, err);
      }
    },
  );

  return router;
}

// ── edge dispatchers ─────────────────────────────────────────────────────────

async function createEdge(
  l: Live,
  agent: AgentRow,
  body: Record<string, unknown>,
): Promise<{ id: string; kind: string; source: string; target: string }> {
  const kind = String(body['kind'] ?? '');
  const source = String(body['source'] ?? '');
  const target = String(body['target'] ?? '');
  const config = (body['config'] as Record<string, unknown> | undefined) ?? {};

  switch (kind) {
    case 'channel_bind': {
      const { channelType, channelKey } = parseChannel(source);
      await l.config.createChannelBinding(agent.id, { channelType, channelKey });
      return { id: `channel_bind:${channelType}:${channelKey}`, kind, source, target };
    }
    case 'skill': {
      const subId = idAfter(source, 'subagent');
      const skillId = idAfter(target, 'skill');
      await l.graph.setSubAgentSkill(subId, skillId);
      return { id: `skill:${subId}`, kind, source: `subagent:${subId}`, target };
    }
    case 'tool_grant': {
      const onAgent = source.startsWith('agent:');
      const subAgentId = onAgent ? null : idAfter(source, 'subagent');
      const toolKind = (config['toolKind'] as 'native' | 'mcp') ?? 'native';
      const toolRef = String(config['toolRef'] ?? idAfter(target, 'tool'));
      const mcpServerId = (config['mcpServerId'] as string | null) ?? null;
      if (!toolRef) {
        throw new ConfigValidationError('tool_grant requires a toolRef');
      }
      const grant = await l.graph.createToolGrant({
        agentId: onAgent ? agent.id : null,
        subAgentId,
        toolKind,
        toolRef,
        mcpServerId,
      });
      return { id: `tool_grant:${grant.id}`, kind, source, target };
    }
    case 'subagent':
    case 'schedule':
      // Sub-agents and schedules are created via their own POST endpoints; the
      // ownership edge is implicit. Return it idempotently for the canvas.
      return { id: `${kind}:${idAfter(target, target.split(':', 1)[0] ?? '')}`, kind, source, target };
    default:
      throw new ConfigValidationError(`unknown edge kind "${kind}"`);
  }
}

async function deleteEdge(l: Live, id: string, kind: string): Promise<void> {
  switch (kind) {
    case 'channel_bind': {
      const rest = id.slice('channel_bind:'.length);
      const sep = rest.indexOf(':');
      const channelType = sep >= 0 ? rest.slice(0, sep) : rest;
      const channelKey = sep >= 0 ? rest.slice(sep + 1) : '';
      await l.config.removeChannelBinding(channelType, channelKey);
      return;
    }
    case 'subagent':
      await l.graph.deleteSubAgent(id.slice('subagent:'.length));
      return;
    case 'skill':
      await l.graph.setSubAgentSkill(id.slice('skill:'.length), null);
      return;
    case 'tool_grant':
      await l.graph.deleteToolGrant(id.slice('tool_grant:'.length));
      return;
    case 'schedule':
      await l.graph.deleteSchedule(id.slice('schedule:'.length));
      return;
    default:
      throw new ConfigValidationError(`unknown edge kind "${kind}"`);
  }
}

// ── graph assembly ─────────────────────────────────────────────────────────

function assembleGraph(
  agent: AgentRow,
  bindings: readonly { channelType: string; channelKey: string }[],
  subAgents: readonly SubAgentRow[],
  skills: readonly SkillRow[],
  grants: readonly ToolGrantRow[],
  servers: readonly McpServerRow[],
  schedules: readonly ScheduleRow[],
  registry: OrchestratorRegistry | undefined,
) {
  const mySubs = subAgents.filter((s) => s.parentAgentId === agent.id);
  const subIds = new Set(mySubs.map((s) => s.id));
  const myGrants = grants.filter(
    (g) =>
      (g.agentId && g.agentId === agent.id) ||
      (g.subAgentId && subIds.has(g.subAgentId)),
  );

  const edges: { id: string; kind: string; source: string; target: string }[] = [];
  for (const b of bindings) {
    edges.push({
      id: `channel_bind:${b.channelType}:${b.channelKey}`,
      kind: 'channel_bind',
      source: `channel:${b.channelType}:${b.channelKey}`,
      target: `agent:${agent.id}`,
    });
  }
  for (const s of mySubs) {
    edges.push({
      id: `subagent:${s.id}`,
      kind: 'subagent',
      source: `agent:${agent.id}`,
      target: `subagent:${s.id}`,
    });
    if (s.skillId) {
      edges.push({
        id: `skill:${s.id}`,
        kind: 'skill',
        source: `subagent:${s.id}`,
        target: `skill:${s.skillId}`,
      });
    }
  }
  for (const g of myGrants) {
    edges.push({
      id: `tool_grant:${g.id}`,
      kind: 'tool_grant',
      source: g.agentId ? `agent:${agent.id}` : `subagent:${g.subAgentId}`,
      target: `tool:${g.toolRef}`,
    });
  }
  for (const sc of schedules) {
    edges.push({
      id: `schedule:${sc.id}`,
      kind: 'schedule',
      source: `schedule:${sc.id}`,
      target: `agent:${agent.id}`,
    });
  }

  return {
    agent: agentNode(agent, registry),
    channels: bindings.map((b) => ({
      channelType: b.channelType,
      channelKey: b.channelKey,
      position: null,
    })),
    subAgents: mySubs.map(subAgentNode),
    skills: skills.map(skillNode),
    tools: myGrants.map(toolGrantNode),
    mcpServers: servers.map(mcpNode),
    schedules: schedules.map(scheduleNode),
    edges,
  };
}

// ── node mappers ─────────────────────────────────────────────────────────────

/**
 * Map an `AgentRow` to the canvas `agent` node payload. Exported for unit
 * tests so the `effectiveModel` surface stays covered without spinning up
 * the express app.
 */
export function agentNode(a: AgentRow, registry: OrchestratorRegistry | undefined) {
  // Issue #296 acceptance #4 — surface the orchestrator model the registry
  // actually resolved for this Agent (per-Agent overlay applied to the
  // platform default). Absent when the registry has not yet built the Agent
  // (in-memory bootstrap / Agent disabled); UI then shows just the persisted
  // `modelRouting.main` as a hint.
  const built = registry?.get(a.slug)?.built;
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    privacyProfile: a.privacyProfile,
    status: a.status,
    modelRouting: (a.modelRouting as Record<string, unknown> | null) ?? null,
    effectiveModel: built?.effectiveModel ?? null,
    position: a.canvasPosition ?? null,
  };
}

function subAgentNode(s: SubAgentRow) {
  return {
    id: s.id,
    parentAgentId: s.parentAgentId,
    name: s.name,
    skillId: s.skillId,
    model: s.model,
    maxTokens: s.maxTokens,
    maxIterations: s.maxIterations,
    systemPromptOverride: s.systemPromptOverride,
    status: s.status,
    position: s.position,
  };
}

function skillNode(s: SkillRow) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    body: s.body,
    source: s.source,
  };
}

function toolGrantNode(g: ToolGrantRow) {
  return {
    id: g.id,
    agentId: g.agentId,
    subAgentId: g.subAgentId,
    toolKind: g.toolKind,
    toolRef: g.toolRef,
    mcpServerId: g.mcpServerId,
  };
}

function mcpNode(s: McpServerRow) {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    endpoint: s.endpoint,
    status: s.status,
    lastDiscoveredAt: s.lastDiscoveredAt ? s.lastDiscoveredAt.toISOString() : null,
    discoveredTools: s.discoveredTools,
  };
}

function scheduleNode(s: ScheduleRow) {
  return {
    id: s.id,
    agentId: s.agentId,
    cron: s.cron,
    timezone: s.timezone,
    payload: s.payload,
    status: s.status,
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
  };
}

function toMcpConfig(row: McpServerRow): McpServerConfig {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.headers ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    endpoint: row.endpoint,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** `channel:<type>:<key>` where key may itself contain ':'. */
function parseChannel(source: string): { channelType: string; channelKey: string } {
  const rest = source.startsWith('channel:') ? source.slice('channel:'.length) : source;
  const sep = rest.indexOf(':');
  if (sep < 0) throw new ConfigValidationError(`malformed channel node id "${source}"`);
  return { channelType: rest.slice(0, sep), channelKey: rest.slice(sep + 1) };
}

function idAfter(nodeIdStr: string, prefix: string): string {
  const p = `${prefix}:`;
  return nodeIdStr.startsWith(p) ? nodeIdStr.slice(p.length) : nodeIdStr;
}

async function reload(l: Live): Promise<unknown> {
  if (!l.registry) return undefined;
  try {
    return await l.registry.reload();
  } catch {
    return undefined;
  }
}

function fail(res: Response, err: unknown): void {
  if (err instanceof ConfigValidationError) {
    res.status(409).json({ error: 'config_validation', message: err.message });
    return;
  }
  res.status(500).json({ error: 'internal', message: msg(err) });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Express 5 types `req.params[x]` / `req.query[x]` as `string | string[]`.
 * Coerce to a single string (first element of an array, else empty) so route
 * handlers can pass them to string-typed store methods.
 */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}
