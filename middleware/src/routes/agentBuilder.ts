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
  type PersonaSkillRow,
  type ScheduleRow,
  type SkillRow,
  type SubAgentRow,
  type ToolGrantRow,
} from '@omadia/orchestrator';
import { McpManager } from '@omadia/orchestrator';
import { Router, type Request, type Response } from 'express';

import { scanSkillForRisks } from '../services/skillGuard.js';
import { importSkillMarkdown } from '../services/skillImport.js';
import { serializeSkillMarkdown } from '../services/skillLoader.js';

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
      const [bindings, subAgents, skills, grants, servers, schedules, personaSkillLinks] =
        await Promise.all([
          l.config.listChannelBindingsForAgent(agent.id),
          l.graph.listAllSubAgents(),
          l.graph.listSkills(),
          l.graph.listAllToolGrants(),
          l.graph.listMcpServers(),
          l.graph.listSchedulesForAgent(agent.id),
          l.graph.listPersonaSkills(agent.id),
        ]);
      res.json(
        assembleGraph(
          agent,
          bindings,
          subAgents,
          skills,
          grants,
          servers,
          schedules,
          l.registry,
          personaSkillLinks,
        ),
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

  // ── persona skills (Wave 8 — direct-answer identity candidates) ─────────
  // Attached straight to the Agent, no sub-agent in between: the per-turn
  // classifier (`routeTurnPersona`) picks at most one to answer as. Current
  // links + names come back on `/agents/:slug/graph` (`agent.personaSkillIds`
  // + `skills`) — no separate GET here to avoid a second source of truth.
  router.post(
    '/agents/:slug/persona-skills',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const agent = await agentOr404(l, str(req.params.slug), res);
        if (!agent) return;
        const skillId = str((req.body ?? {}).skillId);
        if (!isUuid(skillId)) {
          res.status(400).json({ error: 'invalid_skill_id' });
          return;
        }
        const skill = await l.graph.getSkill(skillId);
        if (!skill) {
          res.status(400).json({ error: 'skill_not_found', skillId });
          return;
        }
        // A persona skill drives the TOP-LEVEL orchestrator with its full
        // tool access — a bigger blast radius than a scoped sub-agent skill
        // grant. Re-scan at attach time (not just import time), same
        // warn-only guard as Wave 5; the UI surfaces `risks` before the
        // operator confirms, but the attach itself is never blocked.
        const risks = scanSkillForRisks(skill.frontmatter, skill.body);
        const link = await l.graph.addPersonaSkill(agent.id, skillId);
        await reload(l);
        res.json({
          agentId: link.agentId,
          skillId: link.skillId,
          position: link.position,
          risks,
        });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  router.delete(
    '/agents/:slug/persona-skills/:skillId',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const agent = await agentOr404(l, str(req.params.slug), res);
        if (!agent) return;
        await l.graph.removePersonaSkill(agent.id, str(req.params.skillId));
        await reload(l);
        res.status(204).end();
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
      // `risks` (Wave 5 heuristic scan, cheap/regex — no LLM call) rides on
      // the bulk list so any skill-browsing surface (Registry, the Wave 8
      // persona-attach picker) shows CURRENT risk state, not just a
      // point-in-time snapshot from import/attach time.
      const skills = (await l.graph.listSkills()).map((s) => ({
        ...skillNode(s),
        risks: scanSkillForRisks(s.frontmatter, s.body),
      }));
      res.json({ skills });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/skills/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      // Guard the id shape so a malformed id is a clean 404 rather than a
      // Postgres "invalid input syntax for type uuid" 500 that leaks the raw
      // DB error.
      if (!isUuid(id)) {
        res.status(404).json({ error: 'skill_not_found', id });
        return;
      }
      const skill = await l.graph.getSkill(id);
      if (!skill) {
        res.status(404).json({ error: 'skill_not_found', id });
        return;
      }
      const [usedBy, usedByAgents] = await Promise.all([
        l.graph.listSubAgentsBySkillId(skill.id),
        l.graph.listAgentsByPersonaSkillId(skill.id),
      ]);
      res.json({
        ...skillNode(skill),
        usedByCount: usedBy.length,
        usedByAgentsCount: usedByAgents.length,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/skills', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const b = req.body ?? {};
      // Validate provenance fields at the boundary: `source` is a closed set,
      // `frontmatter` must be a plain object. Bad input falls back to defaults
      // rather than tripping a DB CHECK.
      const source = b.source === 'file' ? 'file' : b.source === 'db' ? 'db' : undefined;
      const frontmatter =
        b.frontmatter && typeof b.frontmatter === 'object' && !Array.isArray(b.frontmatter)
          ? (b.frontmatter as Record<string, unknown>)
          : undefined;
      const row = await l.graph.upsertSkill({
        slug: String(b.slug ?? '').trim(),
        name: String(b.name ?? '').trim(),
        description: b.description ?? null,
        body: b.body ?? '',
        frontmatter,
        source,
        sourcePath: typeof b.sourcePath === 'string' ? b.sourcePath : null,
      });
      res.json(skillNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  // Import a SKILL.md (paste or uploaded file content) into the registry as a
  // `source:'file'` skill. `dryRun:true` returns the computed outcome +
  // normalized preview without persisting. Only frontmatter+body are ingested;
  // bundled executable code is never run (that is the signed plugin path).
  router.post('/skills/import', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const b = req.body ?? {};
      const raw = typeof b.raw === 'string' ? b.raw : '';
      if (!raw.trim()) {
        res.status(400).json({ error: 'empty_skill', message: 'raw SKILL.md content is required' });
        return;
      }
      const sourcePath = typeof b.sourcePath === 'string' ? b.sourcePath : undefined;
      const dryRun = b.dryRun === true;
      // Validate bundled resources at the boundary: array of {name, content}.
      const resources = Array.isArray(b.resources)
        ? b.resources
            .filter(
              (r: unknown): r is { name: string; content: string } =>
                !!r &&
                typeof r === 'object' &&
                typeof (r as { name?: unknown }).name === 'string' &&
                typeof (r as { content?: unknown }).content === 'string' &&
                isSafeResourceName((r as { name: string }).name),
            )
            .map((r: { name: string; content: string }) => ({ name: r.name, content: r.content }))
        : undefined;
      const result = await importSkillMarkdown(l.graph, { raw, sourcePath, resources }, { dryRun });
      if (!dryRun && result.outcome !== 'unchanged') await reload(l);
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/skills/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      // Validate at the boundary like POST: only forward known fields, and
      // reject a non-object `frontmatter` so it can't corrupt the jsonb column
      // (there is no DB CHECK on frontmatter shape) or break the
      // Record<string, unknown> contract that skillNode now exposes.
      const b = req.body ?? {};
      const patch: {
        name?: string;
        description?: string | null;
        body?: string;
        frontmatter?: Record<string, unknown>;
      } = {};
      if (typeof b.name === 'string') patch.name = b.name;
      if (b.description === null || typeof b.description === 'string') {
        patch.description = b.description;
      }
      if (typeof b.body === 'string') patch.body = b.body;
      if (b.frontmatter && typeof b.frontmatter === 'object' && !Array.isArray(b.frontmatter)) {
        patch.frontmatter = b.frontmatter as Record<string, unknown>;
      }
      const row = await l.graph.updateSkill(str(req.params.id), patch);
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

  // Fork an imported (source:'file') skill into an editable db copy (fork-on-
  // edit). Migrates sub-agent references to the fork; preserves provenance.
  router.post('/skills/:id/fork', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: 'skill_not_found', id });
        return;
      }
      const row = await l.graph.forkSkill(id);
      await reload(l);
      res.json(skillNode(row));
    } catch (err) {
      fail(res, err);
    }
  });

  // Export a skill back to a portable SKILL.md (frontmatter + body).
  router.get('/skills/:id/export', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: 'skill_not_found', id });
        return;
      }
      const skill = await l.graph.getSkill(id);
      if (!skill) {
        res.status(404).json({ error: 'skill_not_found', id });
        return;
      }
      const frontmatter: Record<string, unknown> = {
        ...skill.frontmatter,
        name: skill.name,
        ...(skill.description !== null ? { description: skill.description } : {}),
      };
      // Sanitize the filename: slugs are server-generated kebab, but db-source
      // slugs come from POST /skills unvalidated, so never trust them in a header.
      const safeName = skill.slug.replace(/[^a-zA-Z0-9._-]/g, '_') || 'skill';
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${safeName}.SKILL.md"`);
      res.send(serializeSkillMarkdown(frontmatter, skill.body));
    } catch (err) {
      fail(res, err);
    }
  });

  // List a skill's bundled resources (#391 bundles).
  router.get('/skills/:id/resources', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      if (!isUuid(id)) {
        res.status(404).json({ error: 'skill_not_found', id });
        return;
      }
      // `?names=1` returns metadata only — the registry lists names and
      // shouldn't pull potentially large resource bodies to do so.
      const namesOnly = str(req.query.names) === '1';
      const resources = (await l.graph.listSkillResources(id)).map((r) =>
        namesOnly ? { name: r.name } : { name: r.name, content: r.content },
      );
      res.json({ resources });
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
  personaSkillLinks: readonly PersonaSkillRow[] = [],
) {
  const mySubs = subAgents.filter((s) => s.parentAgentId === agent.id);
  const myPersonaLinks = personaSkillLinks.filter(
    (l) => l.agentId === agent.id,
  );
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
  // Wave 8 — direct-answer persona skills, attached straight to the Agent
  // (no sub-agent in between).
  for (const l of myPersonaLinks) {
    edges.push({
      id: `persona_skill:${agent.id}:${l.skillId}`,
      kind: 'persona_skill',
      source: `agent:${agent.id}`,
      target: `skill:${l.skillId}`,
    });
  }

  return {
    agent: {
      ...agentNode(agent, registry),
      personaSkillIds: myPersonaLinks.map((l) => l.skillId),
    },
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
    frontmatter: s.frontmatter,
    source: s.source,
    sourcePath: s.sourcePath,
    contentHash: s.contentHash,
    forkedFrom: s.forkedFrom,
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string — guards `:id` routes against non-UUID input. */
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * Reject empty / path-like resource names at the boundary. Resources are DB
 * blobs today, but a stored `../x` name would become a path-traversal write if
 * the future runtime materializes them as files — cheaper to guard now.
 */
function isSafeResourceName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !n.includes('/') && !n.includes('\\') && !n.includes('..');
}
