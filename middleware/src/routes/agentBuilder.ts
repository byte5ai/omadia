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
import { McpManager, mcpToolNameFromRef } from '@omadia/orchestrator';
import { Router, type Request, type Response } from 'express';

import {
  MCP_SEVERITIES_NEEDING_ACK,
  refreshMcpGrantPolicy,
} from '../services/mcpGrantPolicy.js';
import { scanDiscoveredTools } from '../services/mcpToolGuard.js';
import { scanSkillForRisks } from '../services/skillGuard.js';
import { importSkillMarkdown } from '../services/skillImport.js';
import { serializeSkillMarkdown } from '../services/skillLoader.js';
import {
  combineWithLlmSeverity,
  CURRENT_VERIFIER_VERSION,
  getOrComputeVerdict,
  type Severity,
  type SkillVerdictRiskCodesEntry,
  type SkillVerdictRow,
  type SkillVerdictStore,
} from '../services/skillVerdict.js';
import {
  getOrComputeLlmVerdict,
  type LlmVerdictStore,
  type LlmVerifier,
} from '../services/skillVerdictLlmVerifier.js';

export interface AgentBuilderRouterOptions {
  readonly getConfigStore: () => ConfigStore | undefined;
  readonly getGraphStore: () => AgentGraphStore | undefined;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  /** The orchestrator's single configured LLM provider id (live-read from the
   *  installed `@omadia/orchestrator` config, default `anthropic`). Scopes
   *  per-Agent / sub-agent model writes to this provider so a cross-provider
   *  pick is rejected instead of silently dropped at build (issue #296). */
  readonly getActiveProvider?: () => string | undefined;
  /** Phase 1b (issue #436) — resolves the configured LLM instruction-intent
   *  verifier, or `undefined` if no LLM provider is configured/available.
   *  Deliberately explicit-trigger only (see `/verdict/llm-scan` below), never
   *  auto-fired from a list/bulk path, to keep LLM cost a deliberate action. */
  readonly getLlmVerifier?: () => Promise<LlmVerifier | undefined>;
}

interface Live {
  readonly config: ConfigStore;
  readonly graph: AgentGraphStore;
  readonly registry: OrchestratorRegistry | undefined;
}

interface SkillVerdictField {
  readonly severity: Severity | null;
  readonly riskCodes: readonly string[];
  readonly notYetScanned: boolean;
}

const EMPTY_SKILL_VERDICTS = new Map<string, SkillVerdictRow>();

/** Adapter from the orchestrator's model-scoped verdict methods to the
 *  `LlmVerdictStore` port `skillVerdictLlmVerifier.ts` depends on. */
function llmVerdictStoreFor(l: Live): LlmVerdictStore {
  return {
    getVerdictByModel: (contentHash, verifierVersion, modelId, promptHash) =>
      l.graph.getSkillVerdictByModel(contentHash, verifierVersion, modelId, promptHash),
    upsertVerdict: (row) => l.graph.upsertSkillVerdict(row),
  };
}

/** Adapter for the deterministic (regex) verifier's cache-aside compute —
 *  cheap and synchronous-safe (no LLM/network I/O), so it's fine to `await`
 *  directly in a mutating request handler (import/patch), unlike the LLM
 *  path which stays explicit-trigger + backgrounded. */
function deterministicVerdictStoreFor(l: Live): SkillVerdictStore {
  return {
    getVerdict: (contentHash, verifierVersion) => l.graph.getSkillVerdict(contentHash, verifierVersion),
    upsertVerdict: (row) => l.graph.upsertSkillVerdict(row),
    getAck: (contentHash, verifierVersion) => l.graph.getSkillVerdictAck(contentHash, verifierVersion),
    upsertAck: (contentHash, verifierVersion, ackedBy) =>
      l.graph.upsertSkillVerdictAck(contentHash, verifierVersion, ackedBy).then(() => undefined),
  };
}

/** Flattens the nested per-verifier risk-code entries to a plain list of
 *  codes — the wire shape the web-ui's `SkillVerdict.riskCodes: string[]`
 *  actually expects (post-review fix: the nested shape was leaking straight
 *  to the client and crashing the "why" panel render). */
function flattenRiskCodes(entries: readonly SkillVerdictRiskCodesEntry[]): string[] {
  return entries.flatMap((entry) => entry.risks.map((risk) => risk.code));
}

function skillVerdictField(
  contentHash: string | null,
  verdicts: ReadonlyMap<string, SkillVerdictRow>,
): SkillVerdictField {
  const row = contentHash ? verdicts.get(contentHash) : undefined;
  if (!row) {
    return { severity: null, riskCodes: [], notYetScanned: true };
  }
  return {
    severity: row.severity,
    riskCodes: flattenRiskCodes(row.riskCodes),
    notYetScanned: false,
  };
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
          l.graph.listMcpServers().then((rows) => withToolVerdicts(l, rows)),
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
      const rows = await l.graph.listSkills();
      const hashes = rows
        .map((s) => s.contentHash)
        .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
      // Read-only lookup only: GET /skills must never compute verdicts or
      // trigger any LLM/scan path for this field.
      const verdicts = await l.graph.getSkillVerdictsByContentHashes(
        hashes,
        CURRENT_VERIFIER_VERSION,
      );
      // `risks` (Wave 5 heuristic scan, cheap/regex — no LLM call) rides on
      // the bulk list so any skill-browsing surface (Registry, the Wave 8
      // persona-attach picker) shows CURRENT risk state, not just a
      // point-in-time snapshot from import/attach time.
      const skills = rows.map((s) => ({
        ...skillNode(s),
        verdict: skillVerdictField(s.contentHash, verdicts),
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
      // Read-only lookup only: detail fetch may surface a persisted verdict but
      // must never compute one on demand (the LLM scan is explicit-trigger
      // only, via POST /verdict/llm-scan below — never fired from a GET).
      const [row, llmVerifier, usedBy, usedByAgents] = await Promise.all([
        skill.contentHash === null
          ? Promise.resolve(undefined)
          : l.graph.getSkillVerdict(skill.contentHash, CURRENT_VERIFIER_VERSION),
        options.getLlmVerifier?.() ?? Promise.resolve(undefined),
        l.graph.listSubAgentsBySkillId(skill.id),
        l.graph.listAgentsByPersonaSkillId(skill.id),
      ]);
      const llmRow =
        skill.contentHash !== null && llmVerifier
          ? await l.graph.getSkillVerdictByModel(
              skill.contentHash,
              CURRENT_VERIFIER_VERSION,
              llmVerifier.modelId,
              llmVerifier.promptHash,
            )
          : undefined;
      const deterministicField = skillVerdictField(
        skill.contentHash,
        row ? new Map<string, SkillVerdictRow>([[row.contentHash, row]]) : EMPTY_SKILL_VERDICTS,
      );
      res.json({
        ...skillNode(skill),
        verdict: {
          ...deterministicField,
          // Combined severity (deterministic ⊕ LLM, worst-wins) is what the
          // frontend's single badge renders — the LLM layer can only
          // escalate, never soften, the deterministic finding.
          severity:
            llmRow && deterministicField.severity
              ? combineWithLlmSeverity(deterministicField.severity, llmRow.severity)
              : llmRow?.severity ?? deterministicField.severity,
          llm: llmRow
            ? { severity: llmRow.severity, rationale: llmRow.rationale, computedAt: llmRow.computedAt }
            : null,
        },
        usedByCount: usedBy.length,
        usedByAgentsCount: usedByAgents.length,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Audit + RBAC note: this is the first persisted audit trail for a skill-side
  // mutation (`acked_by`/`acked_at` records who acted and when). Access stays
  // at the router-level `requireAuth` gate, matching every other skill route:
  // omadia does not have role differentiation today (`sessionJwt.ts`
  // hardcodes `role:'admin'`), so a finer-grained "who may suppress a
  // high_risk verdict" policy is a pre-existing platform gap and must not be
  // invented unilaterally here. Acks key to `(content_hash, verifier_version)`,
  // so a suppression never carries forward across a verifier upgrade.
  router.post('/skills/:id/verdict/ack', async (req: Request, res: Response) => {
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
      // Acks are keyed by canonical `(content_hash, verifier_version)`, so a
      // skill that has never been hashed cannot carry a durable suppression.
      if (skill.contentHash === null) {
        res.status(409).json({ error: 'skill_not_hashed', id });
        return;
      }
      const actor = req.session?.sub || req.session?.email;
      if (!actor) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const ack = await l.graph.upsertSkillVerdictAck(
        skill.contentHash,
        CURRENT_VERIFIER_VERSION,
        actor,
      );
      // Post-review fix: the response must be a full verdict (severity +
      // riskCodes), not just the ack fields — the client does a wholesale
      // `setVerdict(response)` and was previously left with an
      // effectively-empty verdict object, which flipped the badge back to
      // "not yet scanned" instead of showing the acknowledged finding.
      const verdictRow = await getOrComputeVerdict(
        deterministicVerdictStoreFor(l),
        skill.contentHash,
        skill.frontmatter,
        skill.body,
      );
      res.json({
        severity: verdictRow.severity,
        riskCodes: flattenRiskCodes(verdictRow.riskCodes),
        computedAt: verdictRow.computedAt,
        ackedBy: ack.ackedBy,
        ackedAt: ack.ackedAt,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Phase 1b (issue #436) — explicit trigger only. Deliberately NOT fired
  // automatically from any GET: an LLM call is a real cost, so an operator
  // (or a future "scan on import" opt-in) must ask for it. Returns
  // immediately — `getOrComputeLlmVerdict` persists a `pending` row and runs
  // the actual scan in a detached background task, never blocking this
  // response on the LLM call itself.
  router.post('/skills/:id/verdict/llm-scan', async (req: Request, res: Response) => {
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
      if (skill.contentHash === null) {
        res.status(409).json({ error: 'skill_not_hashed', id });
        return;
      }
      const verifier = await options.getLlmVerifier?.();
      if (!verifier) {
        res.status(503).json({ error: 'llm_verifier_unavailable' });
        return;
      }
      const row = await getOrComputeLlmVerdict(
        llmVerdictStoreFor(l),
        verifier,
        skill.contentHash,
        skill.frontmatter,
        skill.body,
      );
      res.json({ llm: { severity: row.severity, rationale: row.rationale, computedAt: row.computedAt } });
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
      if (!dryRun && result.outcome !== 'unchanged') {
        await reload(l);
        // Post-review fix: the deterministic verdict was previously only ever
        // computed by the offline backfill script — a skill imported through
        // this route (the primary onboarding path) never got scanned until
        // someone manually ran that script. Cheap (regex-only), so safe to
        // await inline here, unlike the Phase 1b LLM path.
        await getOrComputeVerdict(
          deterministicVerdictStoreFor(l),
          result.contentHash,
          result.skill.frontmatter,
          result.skill.body,
        );
      }
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
      // Post-review fix: re-scan on edit — the same "never scanned outside
      // manual backfill" gap as the import route, for the edit path.
      if (row.contentHash !== null) {
        await getOrComputeVerdict(deterministicVerdictStoreFor(l), row.contentHash, row.frontmatter, row.body);
      }
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
      res.json({ servers: (await withToolVerdicts(l, await l.graph.listMcpServers())).map(mcpNode) });
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

  /** Enable/disable a server (issue #460). Disabling does not delete grants;
   *  the registry reload drops the server's tools from live orchestrators. */
  router.patch('/mcp-servers/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      const status = req.body?.status;
      if (status !== 'enabled' && status !== 'disabled') {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      const row = (await l.graph.listMcpServers()).find((s) => s.id === id);
      if (!row) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      await l.graph.setMcpServerStatus(id, status);
      await reload(l);
      const updated = (await l.graph.listMcpServers()).find((s) => s.id === id);
      const [decorated] = await withToolVerdicts(l, updated ? [updated] : []);
      res.json(decorated ? mcpNode(decorated) : { id, status });
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
      // Scan gate (epic #459 W1, issue #454): every discovered tool is scanned
      // and its verdict persisted BEFORE the tool list itself is stored, so no
      // unscanned tool ever becomes visible or grantable.
      const verdicts = scanDiscoveredTools(row.id, tools);
      for (const verdict of verdicts) {
        await l.graph.upsertMcpToolVerdict(verdict);
      }
      await l.graph.setMcpDiscoveredTools(row.id, tools);
      // Re-discovery can change verdicts (and thus the runtime blocklist) and
      // tool specs. Refresh the policy, then bump the server's grant epoch so
      // the reload's diff actually rebuilds the affected agents — verdict rows
      // alone are invisible to the graph signature (codex finding). The
      // dispatch guard in McpManager enforces the new policy immediately
      // either way; the rebuild re-aligns the visible tool surface.
      await refreshMcpGrantPolicy(l.graph);
      await l.graph.bumpMcpGrantEpoch(row.id);
      await reload(l);
      const updated = (await l.graph.listMcpServers()).find((s) => s.id === row.id);
      const [decorated] = await withToolVerdicts(l, [updated ?? row]);
      res.json(mcpNode(decorated ?? updated ?? row));
    } catch (err) {
      // Discovery talks to an external process — report as a 502, not a 5xx crash.
      res.status(502).json({ error: 'mcp_discover_failed', message: msg(err) });
    }
  });

  // Operator ack for a high-risk MCP tool verdict (issue #454). Mirrors the
  // skill-side `/skills/:id/verdict/ack` audit-trail semantics: keyed by
  // (server, tool, verifier_version) and pinned to the verdict's content hash,
  // so neither a verifier upgrade nor a content change on re-discover lets a
  // stale ack carry forward.
  router.post(
    '/mcp-servers/:id/tools/:toolName/verdict/ack',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const id = str(req.params.id);
        const toolName = str(req.params.toolName);
        const verdict = await l.graph.getMcpToolVerdict(id, toolName, CURRENT_VERIFIER_VERSION);
        if (!verdict) {
          res.status(404).json({ error: 'mcp_tool_verdict_not_found', serverId: id, toolName });
          return;
        }
        const actor = req.session?.sub || req.session?.email;
        if (!actor) {
          res.status(401).json({ error: 'unauthenticated' });
          return;
        }
        const ack = await l.graph.upsertMcpToolVerdictAck(
          id,
          toolName,
          CURRENT_VERIFIER_VERSION,
          verdict.contentHash,
          actor,
        );
        // An ack unblocks the (server, tool) pair. Refresh the policy (the
        // dispatch guard allows immediately), then bump the grant epoch +
        // reload so hydration re-materializes the previously-filtered tool
        // spec without a restart.
        await refreshMcpGrantPolicy(l.graph);
        await l.graph.bumpMcpGrantEpoch(id);
        await reload(l);
        res.json({
          serverId: id,
          toolName,
          severity: verdict.severity,
          riskCodes: flattenRiskCodes(verdict.riskCodes),
          acked: true,
          ackedBy: ack.ackedBy,
          ackedAt: ack.ackedAt.toISOString(),
        });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  // ── mcp audit log + grant matrix (epic #459 W2, issues #461/#462) ─────────
  router.get('/mcp-call-log', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const limitRaw = Number(req.query['limit']);
      const serverId =
        typeof req.query['serverId'] === 'string' && req.query['serverId'] !== ''
          ? req.query['serverId']
          : undefined;
      const beforeId =
        typeof req.query['beforeId'] === 'string' && req.query['beforeId'] !== ''
          ? req.query['beforeId']
          : undefined;
      const entries = await l.graph.listMcpCallLog({
        ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
        ...(serverId ? { serverId } : {}),
        ...(beforeId ? { beforeId } : {}),
      });
      res.json({
        entries: entries.map((e) => ({ ...e, calledAt: e.calledAt.toISOString() })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Read-only grant matrix (issue #461): every persisted MCP grant with its
   *  holder (agent or sub-agent), server, normalized tool name, and current
   *  verdict/ack/blocked state — "granted but not callable" is visible instead
   *  of silent. */
  router.get('/mcp-grants', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const [grants, agents, subAgents, servers, verdicts, acks] = await Promise.all([
        l.graph.listAllToolGrants(),
        l.config.listAgents(),
        l.graph.listAllSubAgents(),
        l.graph.listMcpServers(),
        l.graph.listMcpToolVerdicts(CURRENT_VERIFIER_VERSION),
        l.graph.listMcpToolVerdictAcks(CURRENT_VERIFIER_VERSION),
      ]);
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const subById = new Map(subAgents.map((s) => [s.id, s]));
      const serverById = new Map(servers.map((s) => [s.id, s]));
      const vmap = new Map(verdicts.map((v) => [`${v.serverId} ${v.toolName}`, v]));
      const amap = new Map(acks.map((a) => [`${a.serverId} ${a.toolName}`, a]));
      const rows = grants
        .filter((g) => g.toolKind === 'mcp' && g.mcpServerId !== null)
        .map((g) => {
          const server = g.mcpServerId ? serverById.get(g.mcpServerId) : undefined;
          const toolName = server ? mcpToolNameFromRef(g.toolRef, server.name) : g.toolRef;
          const v = vmap.get(`${g.mcpServerId ?? ''} ${toolName}`);
          const a = amap.get(`${g.mcpServerId ?? ''} ${toolName}`);
          const ackValid = v !== undefined && a !== undefined && a.contentHash === v.contentHash;
          const sub = g.subAgentId ? subById.get(g.subAgentId) : undefined;
          const holderAgent = g.agentId
            ? agentById.get(g.agentId)
            : sub
              ? agentById.get(sub.parentAgentId)
              : undefined;
          return {
            grantId: g.id,
            holderKind: g.subAgentId ? 'subagent' : 'agent',
            agentSlug: holderAgent?.slug ?? null,
            agentName: holderAgent?.name ?? null,
            subAgentId: g.subAgentId,
            subAgentName: sub?.name ?? null,
            serverId: g.mcpServerId,
            serverName: server?.name ?? null,
            toolName,
            severity: v?.severity ?? null,
            notYetScanned: v === undefined,
            acked: ackValid,
            blocked: v !== undefined && MCP_SEVERITIES_NEEDING_ACK.has(v.severity) && !ackValid,
          };
        });
      res.json({ grants: rows });
    } catch (err) {
      fail(res, err);
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
      // Grant gate (issue #454, fail-closed after codex review): an MCP tool
      // is grantable only when a CURRENT verdict row exists — an unknown
      // toolRef or a server discovered before the scan gate shipped must be
      // (re-)discovered first, otherwise "never scanned" would be a bypass.
      // high_risk/scan_failed/too_large_to_scan additionally need a
      // content-hash-matching operator ack. Enforced server-side, not just in
      // the Builder UI dialog — unlike the skill-side attach gate, which is
      // client-only (documented platform gap).
      if (toolKind === 'mcp') {
        if (!mcpServerId) {
          throw new ConfigValidationError('mcp tool_grant requires an mcpServerId');
        }
        const server = (await l.graph.listMcpServers()).find((s) => s.id === mcpServerId);
        if (!server) {
          throw new ConfigValidationError(`mcp server ${mcpServerId} not found`);
        }
        const toolName = mcpToolNameFromRef(toolRef, server.name);
        const verdict = await l.graph.getMcpToolVerdict(
          mcpServerId,
          toolName,
          CURRENT_VERIFIER_VERSION,
        );
        if (!verdict) {
          throw new ConfigValidationError(
            `mcp_tool_not_scanned: tool "${toolName}" has no current scan verdict; run Discover on server "${server.name}" before granting`,
          );
        }
        if (MCP_SEVERITIES_NEEDING_ACK.has(verdict.severity)) {
          const ack = await l.graph.getMcpToolVerdictAck(
            mcpServerId,
            toolName,
            CURRENT_VERIFIER_VERSION,
          );
          if (!ack || ack.contentHash !== verdict.contentHash) {
            throw new ConfigValidationError(
              `mcp_tool_unacked_risk: tool "${toolName}" carries a "${verdict.severity}" scan verdict; acknowledge it in the server's tool list before granting`,
            );
          }
        }
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

interface McpToolVerdictField {
  readonly severity: Severity | null;
  readonly riskCodes: readonly string[];
  readonly notYetScanned: boolean;
  readonly acked: boolean;
  readonly ackStale: boolean;
}

/** Decorates each server's `discoveredTools` entries with a `verdict` field
 *  (severity, flattened risk codes, ack state). Two bulk queries total, so
 *  list/graph renders stay O(1) in query count regardless of server count. */
async function withToolVerdicts(
  l: Live,
  servers: readonly McpServerRow[],
): Promise<readonly McpServerRow[]> {
  const hasTools = servers.some(
    (s) => Array.isArray(s.discoveredTools) && s.discoveredTools.length > 0,
  );
  if (!hasTools) return servers;
  const [verdicts, acks] = await Promise.all([
    l.graph.listMcpToolVerdicts(CURRENT_VERIFIER_VERSION),
    l.graph.listMcpToolVerdictAcks(CURRENT_VERIFIER_VERSION),
  ]);
  const vmap = new Map(verdicts.map((v) => [`${v.serverId} ${v.toolName}`, v]));
  const amap = new Map(acks.map((a) => [`${a.serverId} ${a.toolName}`, a]));
  return servers.map((s) => ({
    ...s,
    discoveredTools: (s.discoveredTools as ReadonlyArray<Record<string, unknown>>).map(
      (tool) => {
        const name = typeof tool['name'] === 'string' ? (tool['name'] as string) : '';
        const v = vmap.get(`${s.id} ${name}`);
        const a = amap.get(`${s.id} ${name}`);
        const ackValid = v !== undefined && a !== undefined && a.contentHash === v.contentHash;
        const verdict: McpToolVerdictField = v
          ? {
              severity: v.severity,
              riskCodes: flattenRiskCodes(v.riskCodes),
              notYetScanned: false,
              acked: ackValid,
              ackStale: a !== undefined && !ackValid,
            }
          : { severity: null, riskCodes: [], notYetScanned: true, acked: false, ackStale: false };
        return { ...tool, verdict };
      },
    ),
  }));
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
