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
  type McpConfigField,
  type McpRegistryRow,
  type McpServerConfig,
  type McpServerRow,
  DEFAULT_MODEL_POLICY,
  type OrchestratorRegistry,
  type PersonaSkillRow,
  type ScheduleRow,
  type SkillRow,
  type SubAgentRow,
  type ToolGrantRow,
} from '@omadia/orchestrator';
import {
  isDeprecatedMcpTransport,
  McpManager,
  mcpToolNameFromRef,
  turnContext,
  today,
  type McpCallLogEntry,
} from '@omadia/orchestrator';
import { Router, type Request, type Response } from 'express';

import {
  parseRequiresTools,
  mcpRowToConfig,
  substituteMcpConfig,
  deriveMcpConfigSchema,
} from '../agents/subAgentToolHydration.js';
import { sessionIdentity } from '../auth/sessionIdentity.js';
import {
  auditIdentity,
  parseDelegation,
  resolveMcpUserKey,
} from '../services/mcpDelegation.js';
import { rescanAllMcpServers } from '../services/mcpRescan.js';
import { redactSecrets } from '../services/secretRedaction.js';
import {
  MCP_SEVERITIES_NEEDING_ACK,
  refreshMcpGrantPolicy,
} from '../services/mcpGrantPolicy.js';
import {
  McpRegistryClient,
  McpRegistryError,
  type McpRegistryConfig,
} from '../services/mcpRegistryClient.js';
import { diffMcpToolAllowlist, scanDiscoveredTools } from '../services/mcpToolGuard.js';
import { scanSkillForRisks } from '../services/skillGuard.js';
import { importSkillMarkdown } from '../services/skillImport.js';
import { serializeSkillMarkdown } from '../services/skillLoader.js';
import {
  combineWithLlmSeverity,
  computeVerdict,
  CURRENT_VERIFIER_VERSION,
  getOrComputeVerdict,
  type Severity,
  type SkillVerdictRiskCodesEntry,
  type SkillVerdictRow,
  type SkillVerdictStore,
} from '../services/skillVerdict.js';
import {
  getOrComputeLlmVerdict,
  sanitizeVerdictRationale,
  type LlmVerdictStore,
  type LlmVerifier,
} from '../services/skillVerdictLlmVerifier.js';
import {
  createPublicMcpBindingsRouter,
  type BindingExistenceCheck,
  type OperatorSessionCheck,
} from './publicMcpBindingsRouter.js';
import type { PublicMcpKeyBindingAdminStore } from '../mcp/publicMcpKeyBindingsAdmin.js';

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
  /** Epic #459 W6 (issue #463): audit observer + dispatch guard for the
   *  router's own McpManager, so sandbox test-calls share the same
   *  enforcement + audit trail as runtime dispatch. */
  readonly mcpCallObserver?: (entry: McpCallLogEntry) => void;
  readonly mcpCallGuard?: (serverId: string, toolName: string) => string | null;
  /** Issue #563 — invoked after a request changed an MCP server's identity,
   *  config or token. The router already drops its OWN pooled connection; this
   *  is how the runtime `McpManager` in `index.ts` (a different instance, with
   *  a different auth provider) gets told to drop this server's too. */
  readonly onMcpServerChanged?: (serverId: string) => void;
  /** Epic #459 W7 (issue #458 UX): lists installed plugins so the operator
   *  grant surface can show which plugins declare `permissions.mcp` and their
   *  manifest `servers_hint`. Returns the plugin id, display name, the mcp
   *  permission flag, and the servers hint. */
  readonly listMcpPluginCandidates?: () => ReadonlyArray<{
    id: string;
    name: string;
    mcp: boolean;
    serversHint: readonly string[];
  }>;
  /** Generic MCP OAuth service (epic #459 W9). Decoupled to a minimal surface
   *  so the router stays testable; the concrete impl is McpOAuthService. */
  readonly mcpOAuth?: {
    readonly redirectUri: string;
    isProtected(server: McpServerRow): Promise<boolean>;
    issuerFor(server: McpServerRow): Promise<string | null>;
    describeAuth(server: McpServerRow): Promise<{
      protected: boolean;
      issuer: string | null;
      issuerHost: string | null;
      brokered: boolean;
      /** W2-4 — which link of the client-acquisition chain applies. */
      acquisitionMode: 'stored' | 'cimd' | 'dcr' | 'manual';
      cimdSupported: boolean;
      cimdBlockedReason: string | null;
    }>;
    beginAuthorization(server: McpServerRow, userKey: string): Promise<{ authorizeUrl: string }>;
    /** `iss` is the RFC 9207 authorization-response parameter (W0-1, D1),
     *  validated against the flow-bound issuer before any exchange. */
    completeAuthorization(state: string, code: string, iss?: string | null): Promise<{ serverId: string }>;
    setManualClient(issuer: string, clientId: string, clientSecret: string | null): Promise<void>;
    getValidAccessToken(server: McpServerRow, userKey: string): Promise<string | null>;
  };
  readonly mcpOAuthUserKey?: string;
  /** Schema-driven MCP config with Vault-backed secrets (epic #459). */
  readonly mcpConfig?: {
    setSecret(serverId: string, key: string, value: string): Promise<void>;
    deleteSecret(serverId: string, key: string): Promise<void>;
    secretsSet(server: McpServerRow): Promise<Record<string, boolean>>;
    getConfigHeaders(cfg: McpServerConfig): Promise<Record<string, string>>;
    getConfigEnv(cfg: McpServerConfig): Promise<Record<string, string>>;
  };
  /** Vault-backed MCP registry bearer tokens (issue #463 item 5). The token is
   *  never persisted on the DB row — the create route stores it here, the
   *  catalog/search proxy resolves it here, delete removes it. Absent → the
   *  registry is treated as keyless. */
  readonly mcpRegistrySecrets?: {
    getToken(registryId: string): Promise<string | undefined>;
    setToken(registryId: string, value: string): Promise<void>;
    deleteToken(registryId: string): Promise<void>;
  };
  /** W5-1 — the WRITE half of `public_mcp_key_bindings`, for the MCP Control
   *  Center's Bindings tab. The public MCP endpoint gets the READ store and
   *  only the read store (`wirePublicMcp.ts`); this one never reaches it.
   *  Absent (no graph pool) ⇒ the sub-routes 503. */
  readonly getPublicMcpBindingStore?: () => PublicMcpKeyBindingAdminStore | undefined;
  /** W5-1 — operator-session check for the binding routes. Absent ⇒ they refuse
   *  to serve at all, rather than relying on the `requireAuth` that happens to
   *  sit in front of this router's mount. */
  readonly operatorAuth?: OperatorSessionCheck;
  /** #571 — resolves whether a binding's `agent_id` / `key_id` actually exist,
   *  so a typo is a 400 (agent) or a warning (key) instead of a
   *  fully-configured-looking dead row. Forwarded verbatim to the binding
   *  router; absent ⇒ existence is never checked. Built in `index.ts`, the one
   *  place with both the registry and the API-key vault in scope. */
  readonly publicMcpBindingExistence?: BindingExistenceCheck;
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

  // W5-1 — public MCP key bindings. Its own router because its auth gate must
  // travel with it rather than depend on this mount sitting behind
  // `requireAuth`; see `publicMcpBindingsRouter.ts`. Mounted first so the
  // prefix cannot be shadowed by a later `/:slug`-shaped route.
  router.use(
    '/public-mcp-bindings',
    createPublicMcpBindingsRouter({
      getStore: () => options.getPublicMcpBindingStore?.(),
      ...(options.operatorAuth ? { operatorAuth: options.operatorAuth } : {}),
      ...(options.publicMcpBindingExistence
        ? { existence: options.publicMcpBindingExistence }
        : {}),
    }),
  );

  const mcp = new McpManager({
    ...(options.mcpCallObserver ? { onToolCall: options.mcpCallObserver } : {}),
    ...(options.mcpCallGuard ? { guard: options.mcpCallGuard } : {}),
    // Resolve Vault-backed config (stdio env + http secret headers) and OAuth
    // tokens at connect time — the SAME provider the orchestrator's manager
    // gets. Without it, discover/test-call spawn stdio servers with NO env, so
    // a server needing credentials dies with "-32000 Connection closed" even
    // though its config is saved (epic #459).
    auth: {
      getToken: async (cfg: McpServerConfig): Promise<string | null> => {
        if (!options.mcpOAuth) return null;
        const graph = options.getGraphStore();
        const server = graph
          ? (await graph.listMcpServers()).find((s) => s.id === cfg.id)
          : undefined;
        if (!server) return null;
        // Per-user token (bugfix, mirrors the runtime McpManager in index.ts):
        // tokens are STORED under the request's session-derived key at connect
        // time, so lookup must use the same key.
        //
        // W0-1 (D2): the previous `?? 'operator'` tail is gone. A `per_user`
        // server with no resolvable identity now yields no token and the call
        // fails closed, instead of quietly using the operator's authority.
        const userKey = resolveMcpUserKey(
          server,
          turnContext.current()?.mcpUserKey,
          options.mcpOAuthUserKey,
        );
        if (userKey === null) return null;
        return options.mcpOAuth.getValidAccessToken(server, userKey);
      },
      resolveIdentity: async (cfg: McpServerConfig): Promise<string | null> => {
        const graph = options.getGraphStore();
        const server = graph
          ? (await graph.listMcpServers()).find((s) => s.id === cfg.id)
          : undefined;
        if (!server) return null;
        return auditIdentity(server, turnContext.current()?.mcpUserKey, options.mcpOAuthUserKey);
      },
      // Discover/test-call surface needs-auth via the route's describeAuth path,
      // so the manager itself doesn't need to synthesize a prompt here.
      onAuthFailure: async (): Promise<string | null> => null,
      ...(options.mcpConfig
        ? {
            getConfigHeaders: (cfg: McpServerConfig): Promise<Record<string, string>> =>
              options.mcpConfig!.getConfigHeaders(cfg),
            getConfigEnv: (cfg: McpServerConfig): Promise<Record<string, string>> =>
              options.mcpConfig!.getConfigEnv(cfg),
          }
        : {}),
    },
  });
  /** Issue #563 — a server's identity, config or token just changed on disk, so
   *  every live connection built from the old values is stale. Drops this
   *  router's own pooled connection and lets the runtime manager drop its one.
   *  The notification is best-effort: an invalidation failure must never turn a
   *  successful write into a failed request. */
  const invalidateMcpServer = async (serverId: string): Promise<void> => {
    await mcp.close(serverId).catch(() => {
      /* best-effort — the entry is already removed from the pool */
    });
    try {
      options.onMcpServerChanged?.(serverId);
    } catch {
      /* an observer must never break the route */
    }
  };

  // Marketplace catalog client (epic #459 W3, issue #455): server-side proxy
  // with a 5-minute cache, so registry tokens never reach the browser.
  const mcpRegistryClient = new McpRegistryClient();

  // Build the client's runtime config from the persisted row, resolving the
  // bearer token from the Vault (issue #463 item 5) — it is never on the row.
  async function toRegistryConfig(row: McpRegistryRow): Promise<McpRegistryConfig> {
    const token =
      row.authKind === 'bearer' && options.mcpRegistrySecrets
        ? ((await options.mcpRegistrySecrets.getToken(row.id)) ?? null)
        : null;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      authKind: row.authKind,
      token,
      kind: row.kind,
    };
  }

  /**
   * Epic #459 — the config fields a server declares, self-healed on demand, plus
   * which REQUIRED fields still have no value. A marketplace server imported
   * before env-var capture has an empty `config_schema` (and a stdio command has
   * no endpoint placeholders to derive from), so re-resolve its registry entry
   * once and persist the declared fields. `missing` lists required fields with
   * no value yet (non-secret from the row, secret from the Vault) — the caller
   * turns that into a config prompt instead of letting the process crash.
   */
  async function resolveServerConfigSchema(
    graph: AgentGraphStore,
    row: McpServerRow,
  ): Promise<{ schema: readonly McpConfigField[]; missing: string[] }> {
    let schema: readonly McpConfigField[] =
      row.configSchema.length > 0
        ? row.configSchema
        : deriveMcpConfigSchema(row.endpoint, row.headers);
    if (schema.length === 0 && row.source === 'marketplace' && row.registryId) {
      try {
        const registry = (await graph.listMcpRegistries()).find((r) => r.id === row.registryId);
        if (registry) {
          const entry = await mcpRegistryClient.resolve(await toRegistryConfig(registry), row.name);
          if (entry.configSchema && entry.configSchema.length > 0) {
            schema = entry.configSchema;
            await graph.setMcpServerConfigSchema(row.id, schema as never);
          }
        }
      } catch {
        /* registry unreachable — keep the empty/derived schema */
      }
    }
    const secretsSet = options.mcpConfig
      ? await options.mcpConfig.secretsSet({ ...row, configSchema: schema })
      : {};
    const missing = schema
      .filter((f) => f.required)
      .filter((f) =>
        f.secret ? !secretsSet[f.key] : row.config[f.key] == null || row.config[f.key] === '',
      )
      .map((f) => f.key);
    return { schema, missing };
  }

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
          // OM-26 read-path scrub: rows persisted BEFORE the verifier started
          // storing `scan_failed:<code>` still hold the raw provider JSON
          // (`request_id` and all). Redacting only in the web-ui renderer would
          // still put it in this response body.
          llm: llmRow
            ? {
                severity: llmRow.severity,
                rationale: sanitizeVerdictRationale(llmRow.severity, llmRow.rationale),
                computedAt: llmRow.computedAt,
              }
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
      // Same OM-26 read-path scrub as GET /skills/:id — this endpoint also
      // serves whatever is already persisted when the verdict is cache-hit.
      res.json({
        llm: {
          severity: row.severity,
          rationale: sanitizeVerdictRationale(row.severity, row.rationale),
          computedAt: row.computedAt,
        },
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
      if (!dryRun && result.outcome !== 'unchanged') {
        await reload(l);
      }
      // Post-review fix: the deterministic verdict was previously only ever
      // computed by the offline backfill script — a skill imported through
      // this route (the primary onboarding path) never got scanned until
      // someone manually ran that script. Cheap (regex-only), so safe to
      // await inline here, unlike the Phase 1b LLM path.
      //
      // OM-25: the verdict used to be computed and then THROWN AWAY, so an
      // import that landed as "⚠ MARKIERT — PRÜFUNG EMPFOHLEN" in the registry
      // was confirmed to the user as a plain success. It now travels on the
      // response. Deriving it client-side from `result.risks` was rejected on
      // purpose: `risks` cannot express `too_large_to_scan` or `scan_failed`,
      // and duplicating `computeVerdict`'s thresholds guarantees drift.
      const verdict = dryRun
        ? // Dry run persists nothing, so read no store — `computeVerdict` is the
          // same pure thresholding the persisted path uses, so the preview and
          // the committed verdict cannot disagree.
          computeVerdict(result.contentHash, result.risks)
        : await getOrComputeVerdict(
            deterministicVerdictStoreFor(l),
            result.contentHash,
            result.skill.frontmatter,
            result.skill.body,
          );
      res.json({
        ...result,
        // Flatten to the plain code list the web-ui's `SkillVerdict.riskCodes`
        // expects — the nested per-verifier shape crashed the "why" panel once
        // already (see `flattenRiskCodes`).
        verdict: {
          severity: verdict.severity,
          riskCodes: flattenRiskCodes(verdict.riskCodes),
        },
      });
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
      const status = req.body?.status as unknown;
      const privacyBypass = req.body?.privacyBypass as unknown;
      const kgIngest = req.body?.kgIngest as unknown;
      const hasStatus = status === 'enabled' || status === 'disabled';
      const hasBypass = typeof privacyBypass === 'boolean';
      const hasKg = typeof kgIngest === 'boolean';
      if (status !== undefined && !hasStatus) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      if (!hasStatus && !hasBypass && !hasKg) {
        res.status(400).json({ error: 'invalid_patch' });
        return;
      }
      const row = (await l.graph.listMcpServers()).find((s) => s.id === id);
      if (!row) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      // Enable gate (issue #455): a server with unacknowledged ack-requiring
      // verdicts cannot be enabled — the operator reviews and acks first.
      if (status === 'enabled') {
        const verdicts = await l.graph.listMcpToolVerdicts(CURRENT_VERIFIER_VERSION);
        const acks = await l.graph.listMcpToolVerdictAcks(CURRENT_VERIFIER_VERSION);
        const ackByTool = new Map(
          acks.filter((a) => a.serverId === id).map((a) => [a.toolName, a]),
        );
        const unacked = verdicts
          .filter((v) => v.serverId === id && MCP_SEVERITIES_NEEDING_ACK.has(v.severity))
          .filter((v) => {
            const ack = ackByTool.get(v.toolName);
            return !ack || ack.contentHash !== v.contentHash;
          })
          .map((v) => ({ toolName: v.toolName, severity: v.severity }));
        if (unacked.length > 0) {
          res.status(409).json({ error: 'mcp_server_has_unacked_risks', tools: unacked });
          return;
        }
      }
      if (hasStatus) await l.graph.setMcpServerStatus(id, status as 'enabled' | 'disabled');
      // Privacy-bypass (epic #459) is read live off the rebuilt DomainTool, so a
      // reload below is what makes the toggle take effect.
      if (hasBypass) await l.graph.setMcpServerPrivacyBypass(id, privacyBypass as boolean);
      if (hasKg) await l.graph.setMcpServerKgIngest(id, kgIngest as boolean);
      // Status changes must reach both enforcement layers: the dispatch guard
      // (policy refresh) and the visible tool surface (epoch bump + rebuild).
      await refreshMcpGrantPolicy(l.graph);
      await l.graph.bumpMcpGrantEpoch(id);
      await l.graph.bumpSkillBindingEpoch(id);
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
      const id = str(req.params.id);
      await l.graph.deleteMcpServer(id);
      await invalidateMcpServer(id);
      await reload(l);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/mcp-servers/:id/discover', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    // Establish the per-request MCP OAuth identity (bugfix): the shared
    // McpManager's getToken reads turnContext.mcpUserKey to look up the token
    // under the SAME key it was stored under (see auth-status/authorize
    // below), instead of silently missing it. `enter` (not `run`) because this
    // scope is naturally bounded by the request's own async chain.
    //
    // W0-1: this carries the session's CANDIDATE identity. Whether it may be
    // replaced by a shared one is decided per server by `resolveMcpUserKey` in
    // the auth provider — not by a default here.
    const discoverIdentity = sessionIdentity(req);
    turnContext.enter({
      turnId: `mcp-discover-${str(req.params.id)}`,
      turnDate: today(),
      ...(discoverIdentity ? { mcpUserKey: discoverIdentity } : {}),
    });
    try {
      const servers = await l.graph.listMcpServers();
      const row = servers.find((s) => s.id === str(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      // Fail fast with a clear message when the endpoint still has an UNFILLED
      // template placeholder AFTER config substitution (e.g. an M365 entry left
      // as `.../tenants/{tenant_id}/...` with no configured tenant_id) —
      // otherwise the upstream 400 surfaces as a cryptic 502 (issue #459).
      const placeholders = substituteMcpConfig(row.endpoint ?? '', row.config).match(/\{[^}]+\}/g);
      if (placeholders && placeholders.length > 0) {
        res.status(422).json({
          error: 'mcp_endpoint_placeholder',
          serverId: row.id,
          serverName: row.name,
          placeholders: [...new Set(placeholders)],
        });
        return;
      }
      // Fail fast (the stdio analog of the placeholder guard): a server that
      // declares required config/env fields can't even start until they're set.
      // Self-heal the schema for pre-capture imports and prompt the config form
      // with a clear 422 instead of letting the process crash into an opaque
      // 502 — "nicht erst gegen einen Fehler laufen lassen" (issue #459).
      const { missing } = await resolveServerConfigSchema(l.graph, row);
      if (missing.length > 0) {
        res.status(422).json({
          error: 'mcp_config_required',
          serverId: row.id,
          serverName: row.name,
          missing,
        });
        return;
      }
      // #545 — Discovery bypasses the tool-list cache: what gets scanned and
      // persisted below must be what the server exposes NOW, not a cached view.
      const tools = await mcp.listTools(toMcpConfig(row), { fresh: true });
      // Scan gate (epic #459 W1, issue #454): every discovered tool is scanned
      // and its verdict persisted BEFORE the tool list itself is stored, so no
      // unscanned tool ever becomes visible or grantable.
      const verdicts = scanDiscoveredTools(row.id, tools);
      for (const verdict of verdicts) {
        await l.graph.upsertMcpToolVerdict(verdict);
      }
      // Prune verdicts for tools this server no longer exposes (codex fold):
      // a hidden/renamed tool must not keep a stale clean verdict.
      await l.graph.pruneMcpToolVerdicts(
        row.id,
        tools.map((t) => t.name),
      );
      await l.graph.setMcpDiscoveredTools(row.id, tools);
      // Re-discovery can change verdicts (and thus the runtime blocklist) and
      // tool specs. Refresh the policy, then bump the server's grant epoch so
      // the reload's diff actually rebuilds the affected agents — verdict rows
      // alone are invisible to the graph signature (codex finding). The
      // dispatch guard in McpManager enforces the new policy immediately
      // either way; the rebuild re-aligns the visible tool surface.
      await refreshMcpGrantPolicy(l.graph);
      await l.graph.bumpMcpGrantEpoch(row.id);
      await l.graph.bumpSkillBindingEpoch(row.id);
      await reload(l);
      const updated = (await l.graph.listMcpServers()).find((s) => s.id === row.id);
      const [decorated] = await withToolVerdicts(l, [updated ?? row]);
      res.json(mcpNode(decorated ?? updated ?? row));
    } catch (err) {
      const raw = msg(err);
      // A protected server can't even list tools without a token — a failed
      // discovery is almost always "not authorized yet". Tell the client to
      // prompt Connect instead of surfacing a cryptic 502 (issue #459).
      if (options.mcpOAuth) {
        try {
          const row = (await l.graph.listMcpServers()).find((s) => s.id === str(req.params.id));
          const desc = row ? await options.mcpOAuth.describeAuth(row) : null;
          if (desc?.protected) {
            res.status(409).json({
              error: 'mcp_needs_auth',
              needsAuth: true,
              serverId: str(req.params.id),
              serverName: row?.name ?? null,
              issuer: desc.issuer,
              issuerHost: desc.issuerHost,
              brokered: desc.brokered,
              message: raw,
            });
            return;
          }
        } catch {
          /* discovery of the auth metadata itself failed — fall through */
        }
      }
      // Discovery talks to an external process — report as a 502, not a 5xx crash.
      res.status(502).json({ error: 'mcp_discover_failed', message: raw });
    }
  });

  // Config schema + values (epic #459). GET returns the declared fields (derived
  // from endpoint/header placeholders when none saved yet), the non-secret
  // values, and which secret fields are set (never the secret values).
  router.get('/mcp-servers/:id/config', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      const row = (await l.graph.listMcpServers()).find((s) => s.id === id);
      if (!row) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      // Self-heals a pre-capture marketplace server's schema and reports
      // required-but-unset fields (shared with the discover config guard).
      const { schema } = await resolveServerConfigSchema(l.graph, row);
      const secretsSet = options.mcpConfig
        ? await options.mcpConfig.secretsSet({ ...row, configSchema: schema })
        : {};
      res.json({ schema, config: row.config, secretsSet });
    } catch (err) {
      fail(res, err);
    }
  });

  // PUT saves the schema (incl. per-field secret flags), the non-secret values,
  // and any provided secret values (secrets → Vault, never the DB row).
  router.put('/mcp-servers/:id/config', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const id = str(req.params.id);
      const row = (await l.graph.listMcpServers()).find((s) => s.id === id);
      if (!row) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      const body = (req.body ?? {}) as {
        schema?: unknown;
        config?: unknown;
        secrets?: unknown;
      };
      if (Array.isArray(body.schema)) {
        await l.graph.setMcpServerConfigSchema(id, body.schema as never);
      }
      if (body.config && typeof body.config === 'object') {
        await l.graph.setMcpServerConfig(id, body.config as Record<string, unknown>);
      }
      if (body.secrets && typeof body.secrets === 'object' && options.mcpConfig) {
        for (const [k, v] of Object.entries(body.secrets as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 0) {
            await options.mcpConfig.setSecret(id, k, v);
          }
        }
      }
      // Config feeds connect-time substitution — refresh + reload so it applies.
      await refreshMcpGrantPolicy(l.graph);
      await l.graph.bumpMcpGrantEpoch(id);
      // …and drop the live connection, which still holds the OLD env/headers.
      await invalidateMcpServer(id);
      await reload(l);
      const updated = (await l.graph.listMcpServers()).find((s) => s.id === id);
      const [decorated] = await withToolVerdicts(l, [updated ?? row]);
      res.json(mcpNode(decorated ?? updated ?? row));
    } catch (err) {
      fail(res, err);
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
        await l.graph.bumpSkillBindingEpoch(id);
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

  // ── plugin mcp grants (epic #459 W5, issue #458) ──────────────────────────

  /** MCP-capable plugins + their current server grants (W7 UX): one payload
   *  that drives the operator's plugin-grant surface. A plugin only appears if
   *  its manifest declares `permissions.mcp`; the servers_hint is the author's
   *  suggestion, binding stays an explicit operator action. */
  router.get('/mcp-plugin-candidates', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const candidates = (options.listMcpPluginCandidates?.() ?? []).filter((p) => p.mcp);
      const [grants, servers] = await Promise.all([
        l.graph.listPluginMcpGrants(),
        l.graph.listMcpServers(),
      ]);
      const grantsByPlugin = new Map<string, string[]>();
      for (const g of grants) {
        const list = grantsByPlugin.get(g.pluginId) ?? [];
        list.push(g.mcpServerId);
        grantsByPlugin.set(g.pluginId, list);
      }
      res.json({
        servers: servers.map((s) => ({ id: s.id, name: s.name, status: s.status })),
        plugins: candidates.map((p) => ({
          pluginId: p.id,
          name: p.name,
          serversHint: p.serversHint,
          grantedServerIds: grantsByPlugin.get(p.id) ?? [],
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/plugin-mcp-grants', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const [grants, servers] = await Promise.all([
        l.graph.listPluginMcpGrants(),
        l.graph.listMcpServers(),
      ]);
      const serverById = new Map(servers.map((s) => [s.id, s]));
      res.json({
        grants: grants.map((g) => ({
          pluginId: g.pluginId,
          serverId: g.mcpServerId,
          serverName: serverById.get(g.mcpServerId)?.name ?? null,
          grantedBy: g.grantedBy,
          grantedAt: g.grantedAt.toISOString(),
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Server-level grant (issue #458): explicit and auditable, never ambient.
   *  Per-tool safety comes from the dispatch guard, which applies to plugin
   *  calls unchanged (unscanned or unacked-risk tools are denied). */
  router.put('/plugin-mcp-grants', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const pluginId = String(req.body?.pluginId ?? '').trim();
      const mcpServerId = String(req.body?.mcpServerId ?? '');
      if (pluginId === '' || !isUuid(mcpServerId)) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      // The plugin must exist in the live catalog AND currently declare
      // permissions.mcp (codex W7 fold): otherwise a direct request could
      // create a stale grant that silently becomes effective if a plugin with
      // that id later declares MCP. Matches the candidate route's policy.
      const candidate = (options.listMcpPluginCandidates?.() ?? []).find(
        (p) => p.id === pluginId && p.mcp,
      );
      if (!candidate) {
        res.status(404).json({ error: 'plugin_not_mcp_capable', pluginId });
        return;
      }
      const server = (await l.graph.listMcpServers()).find((s) => s.id === mcpServerId);
      if (!server) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      const actor = req.session?.sub || req.session?.email;
      if (!actor) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      await l.graph.upsertPluginMcpGrant(pluginId, mcpServerId, actor);
      res.json({ pluginId, serverId: mcpServerId, grantedBy: actor });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/plugin-mcp-grants', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const pluginId = String(req.body?.pluginId ?? '').trim();
      const mcpServerId = String(req.body?.mcpServerId ?? '');
      if (pluginId === '' || !isUuid(mcpServerId)) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      await l.graph.deletePluginMcpGrant(pluginId, mcpServerId);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // ── generic MCP OAuth (epic #459 W9) ──────────────────────────────────────
  // Tokens are keyed to the authenticated operator's identity (codex W9 fold):
  // one operator's token is never reused for another.
  //
  // W0-1 (D2): the identity the SESSION offers, with no fallback baked in. The
  // old `|| 'operator'` tail is gone — whether an unresolved identity may
  // borrow a shared one is now the server's `delegation` decision, applied by
  // `resolveMcpUserKey`, never an implicit default here.
  //
  // W4-1: `sessionIdentity` now lives in `../auth/sessionIdentity.js` (behaviour
  // unchanged) so the chat routes can produce the SAME key these routes consume.
  /** The key to act as for THIS server, or null when a `per_user` server has
   *  no resolvable identity (fail closed — never silently the operator). */
  const oauthUserKeyFor = (req: Request, server: McpServerRow): string | null =>
    resolveMcpUserKey(server, sessionIdentity(req));
  const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  /** Auth status for a server: is it OAuth-protected, is the user connected,
   *  and (if protected) does its issuer still need a one-time manual client. */
  router.get('/mcp-servers/:id/auth-status', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const server = (await l.graph.listMcpServers()).find((s) => s.id === str(req.params.id));
      if (!server) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      if (!options.mcpOAuth) {
        res.json({
          protected: false,
          connected: false,
          issuer: null,
          needsClient: false,
          brokered: false,
          acquisitionMode: 'manual',
          cimdSupported: false,
          cimdBlockedReason: null,
          delegation: server.delegation,
          identityResolved: sessionIdentity(req) !== null,
        });
        return;
      }
      const desc = await options.mcpOAuth.describeAuth(server);
      if (!desc.protected) {
        res.json({
          protected: false,
          connected: false,
          issuer: null,
          needsClient: false,
          brokered: false,
          acquisitionMode: 'manual',
          cimdSupported: false,
          cimdBlockedReason: null,
          delegation: server.delegation,
          identityResolved: sessionIdentity(req) !== null,
        });
        return;
      }
      // W0-1: null under `per_user` with no session identity — report it as
      // not-connected rather than probing the shared operator token.
      const userKey = oauthUserKeyFor(req, server);
      const token =
        userKey === null ? undefined : await l.graph.getMcpOAuthToken(server.id, userKey);
      const client = desc.issuer ? await l.graph.getMcpOAuthClient(desc.issuer) : undefined;
      res.json({
        protected: true,
        connected: token !== undefined,
        issuer: desc.issuer,
        issuerHost: desc.issuerHost,
        // W0-1 (D2): whose authority calls to this server act under, and
        // whether this session actually has an identity to act as.
        delegation: server.delegation,
        identityResolved: userKey !== null,
        // A brokered server needs no manual client even without one stored —
        // either a Client ID Metadata Document (W2-4) or DCR acquires one at
        // connect. Only a server with neither does.
        brokered: desc.brokered,
        // W2-4 — which acquisition mode this issuer is on, so the UI can badge
        // CIMD, explain a CIMD-capable-but-unreachable install, and make clear
        // the manual client remains the Entra ID / Okta path.
        acquisitionMode: desc.acquisitionMode,
        cimdSupported: desc.cimdSupported,
        cimdBlockedReason: desc.cimdBlockedReason,
        needsClient: !desc.brokered && desc.issuer !== null && client === undefined,
        redirectUri: options.mcpOAuth.redirectUri,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Start the OAuth flow — returns the authorize URL to open. */
  router.post('/mcp-servers/:id/authorize', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      if (!options.mcpOAuth) {
        res.status(501).json({ error: 'mcp_oauth_unavailable' });
        return;
      }
      const server = (await l.graph.listMcpServers()).find((s) => s.id === str(req.params.id));
      if (!server) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      // W0-1 (D2): authorizing under a borrowed identity is exactly the
      // confused deputy — a `per_user` server with no session identity has
      // nobody to store the token for, so refuse before starting the flow.
      const userKey = oauthUserKeyFor(req, server);
      if (userKey === null) {
        res.status(403).json({ error: 'delegation_identity_unresolved' });
        return;
      }
      try {
        const { authorizeUrl } = await options.mcpOAuth.beginAuthorization(server, userKey);
        res.json({ authorizeUrl });
      } catch (err) {
        // Issuer without DCR needs a one-time manual client first.
        if (err instanceof Error && err.name === 'McpOAuthNeedsClientError') {
          const issuer = await options.mcpOAuth.issuerFor(server);
          res.status(409).json({ error: 'needs_oauth_client', issuer });
          return;
        }
        throw err;
      }
    } catch (err) {
      fail(res, err);
    }
  });

  /** Register a one-time OAuth client for an issuer that lacks DCR. */
  router.put('/mcp-oauth-clients', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      if (!options.mcpOAuth) {
        res.status(501).json({ error: 'mcp_oauth_unavailable' });
        return;
      }
      const issuer = String(req.body?.issuer ?? '').trim();
      const clientId = String(req.body?.clientId ?? '').trim();
      const clientSecret =
        typeof req.body?.clientSecret === 'string' && req.body.clientSecret !== ''
          ? req.body.clientSecret
          : null;
      if (!/^https?:\/\//.test(issuer) || clientId === '') {
        res.status(400).json({ error: 'invalid_oauth_client' });
        return;
      }
      await options.mcpOAuth.setManualClient(issuer, clientId, clientSecret);
      res.json({ issuer, clientId });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Disconnect: drop the stored token for this user + server. */
  router.delete('/mcp-servers/:id/token', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const server = (await l.graph.listMcpServers()).find((s) => s.id === str(req.params.id));
      if (!server) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      // W0-1: only ever delete the token this caller actually owns. With the
      // old shared fallback an identity-less session could disconnect the
      // operator's token.
      const userKey = oauthUserKeyFor(req, server);
      if (userKey === null) {
        res.status(403).json({ error: 'delegation_identity_unresolved' });
        return;
      }
      await l.graph.deleteMcpOAuthToken(server.id, userKey);
      // The revoked token is still attached to a pooled connection; without
      // this, "Disconnect" leaves an authorized session serving calls.
      await invalidateMcpServer(server.id);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  /** Set a server's delegation mode (W0-1, D2). `per_user` requires each
   *  caller to have its own identity; `service` is the explicit opt-in to one
   *  shared identity. Migration 0031 grandfathers already-connected servers
   *  into `service`, so this is how an operator moves one to `per_user`. */
  router.put('/mcp-servers/:id/delegation', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const delegation = parseDelegation(req.body?.delegation);
      if (delegation === null) {
        res.status(400).json({ error: 'invalid_delegation' });
        return;
      }
      const updated = await l.graph.setMcpServerDelegation(str(req.params.id), delegation);
      if (!updated) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      res.json({ id: updated.id, delegation: updated.delegation });
    } catch (err) {
      fail(res, err);
    }
  });

  /** OAuth callback: exchange the code, store the token, show a done page.
   *  Hit by the operator's own browser redirect (session cookie present); the
   *  `state` param is the CSRF guard. */
  router.get('/mcp-oauth/callback', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    // Escape the detail — it can carry attacker-controlled provider error text
    // (codex W9 fold: reflected XSS on an auth-gated admin origin otherwise).
    const donePage = (ok: boolean, detail: string): string =>
      `<!doctype html><meta charset="utf-8"><title>MCP authorization</title><body style="font-family:system-ui;padding:2rem;max-width:32rem">
       <h2>${ok ? '✅ Connected' : '⚠️ Authorization failed'}</h2><p>${escapeHtml(detail)}</p>
       <p>You can close this tab and return to the MCP Control Center.</p></body>`;
    try {
      if (!options.mcpOAuth) {
        res.status(501).send(donePage(false, 'MCP OAuth is not configured.'));
        return;
      }
      const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
      const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      const providerError = typeof req.query['error'] === 'string' ? req.query['error'] : '';
      // RFC 9207 issuer identifier (W0-1, D1). `state` proves the response
      // belongs to a flow we started; it does NOT prove which authorization
      // server minted the code. A repeated `iss` (Express gives an array) is
      // itself a tampering signal — treat it as a mismatch, not a "pick one".
      const rawIss = req.query['iss'];
      if (rawIss !== undefined && typeof rawIss !== 'string') {
        res.status(400).send(donePage(false, 'The authorization response carried a malformed issuer.'));
        return;
      }
      const iss = typeof rawIss === 'string' ? rawIss : null;
      if (providerError) {
        res.status(400).send(donePage(false, `The provider returned: ${providerError}`));
        return;
      }
      if (code === '' || state === '') {
        res.status(400).send(donePage(false, 'Missing code or state.'));
        return;
      }
      // The service validates `iss` against the flow-bound issuer BEFORE
      // exchanging the code, so a rejected callback stores nothing.
      await options.mcpOAuth.completeAuthorization(state, code, iss);
      res.status(200).send(donePage(true, 'The server is now authorized for you.'));
    } catch (err) {
      // Never echo the raw error here: it can carry the code or the PKCE
      // verifier (D5). The issuer-mismatch case gets an explicit message.
      if (err instanceof Error && err.name === 'McpOAuthIssuerMismatchError') {
        res
          .status(400)
          .send(
            donePage(
              false,
              'The authorization response came from an unexpected issuer and was rejected. Nothing was stored. Please start the connection again.',
            ),
          );
        return;
      }
      res.status(400).send(donePage(false, redactSecrets(msg(err))));
    }
  });

  // ── orchestrator MCP grants from the Control Center (epic #459 W8) ────────
  // The missing "make it usable" step: registering + scanning a server only
  // makes its tools available; they still have to be GRANTED to the
  // orchestrator that handles a chat. This is the same grant the Builder
  // canvas creates (same fail-closed gate), reachable without the canvas.

  router.get('/mcp-orchestrators', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agents = await l.config.listAgents();
      res.json({ orchestrators: agents.map((a) => ({ id: a.id, slug: a.slug, name: a.name })) });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Grant one server tool to an orchestrator (top-level agent), or — with
   *  `toolNames: string[]` — replace the agent's whole tool allowlist for that
   *  server (issue #862). The allowlist IS the set of `agent_tool_grants` rows
   *  for the (agent, server) pair; there is no separate allowlist storage.
   *  Every tool that would be granted runs the same fail-closed verdict gate
   *  as the canvas BEFORE any row is written; one rejection aborts the whole
   *  edit. Then reloads so the orchestrator picks the change up on its next
   *  turn.
   *
   *  `delegation` (optional, 'service' | 'per_user') sets the SERVER's
   *  delegation mode at assignment time. Delegation lives per server
   *  (`mcp_servers.delegation`, resolved at dispatch by `resolveMcpUserKey`) —
   *  a true per-assignment mode would need a schema migration, so the response
   *  reports the actual scope via `delegationScope: 'server'`. */
  router.put('/mcp-grants', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const agentSlug = String(req.body?.agentSlug ?? '').trim();
      const mcpServerId = String(req.body?.mcpServerId ?? '');
      const singleRef = String(req.body?.toolName ?? '');
      const listRefs: unknown = req.body?.toolNames;
      const hasSingle = singleRef !== '';
      const hasList = Array.isArray(listRefs);
      // Exactly one mode: the historical single additive grant, or the
      // allowlist replace. Neither (or both) is a malformed request.
      if (agentSlug === '' || !isUuid(mcpServerId) || hasSingle === hasList) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      if (hasList && listRefs.some((t) => typeof t !== 'string' || t === '')) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      const rawDelegation: unknown = req.body?.delegation;
      const delegation = rawDelegation === undefined ? undefined : parseDelegation(rawDelegation);
      if (delegation === null) {
        res.status(400).json({ error: 'invalid_delegation' });
        return;
      }
      const agent = (await l.config.listAgents()).find((a) => a.slug === agentSlug);
      if (!agent) {
        res.status(404).json({ error: 'orchestrator_not_found', agentSlug });
        return;
      }
      const server = (await l.graph.listMcpServers()).find((s) => s.id === mcpServerId);
      if (!server) {
        res.status(404).json({ error: 'mcp_server_not_found' });
        return;
      }
      // Normalize first, gate later. `mcpToolNameFromRef` strips an optional
      // '<serverName>:' prefix — the same normalization `assertMcpToolAllowed`
      // applies — so the diff below compares names, never raw refs.
      const desiredRefs = hasSingle ? [singleRef] : (listRefs as string[]);
      const desired = desiredRefs.map((ref) => mcpToolNameFromRef(ref, server.name));
      const currentGrants = (await l.graph.listAllToolGrants()).filter(
        (g) =>
          g.toolKind === 'mcp' &&
          g.mcpServerId === mcpServerId &&
          g.agentId === agent.id &&
          g.subAgentId === null,
      );
      // The unique index (0014) keys on the RAW tool_ref, so two persisted
      // rows (e.g. 'search' and 'odoo-mcp:search') can normalize to the SAME
      // tool name. A revoke must delete EVERY row behind the name — the map
      // therefore holds id LISTS, not single ids.
      const grantIdsByTool = new Map<string, string[]>();
      for (const g of currentGrants) {
        const name = mcpToolNameFromRef(g.toolRef, server.name);
        const ids = grantIdsByTool.get(name);
        if (ids) ids.push(g.id);
        else grantIdsByTool.set(name, [g.id]);
      }
      const diff = diffMcpToolAllowlist([...grantIdsByTool.keys()], desired);
      // Single-grant mode stays additive (historical contract); only the
      // allowlist mode revokes what fell off the list.
      const toRevoke = hasList ? diff.toRevoke : [];
      // Gate only what would be WRITTEN (`diff.toGrant`). Already-granted
      // rows passed the gate at creation, and a re-discover can leave one of
      // them "granted but not currently callable" (stale ack) — the dispatch
      // guard in mcpGrantPolicy blocks such a tool at call time regardless,
      // and refusing an unrelated clean edit because of it would jam the
      // editor exactly when the operator needs it. One gate rejection still
      // aborts the whole edit BEFORE any write.
      for (const toolName of diff.toGrant) {
        await assertMcpToolAllowed(l, mcpServerId, toolName);
      }
      const revokeIds = toRevoke.flatMap(
        (toolName) => grantIdsByTool.get(toolName) ?? [],
      );
      if (diff.toGrant.length > 0 || revokeIds.length > 0) {
        // One store-level transaction for the whole edit: a partial failure
        // rolls back, so `granted`/`revoked` in the response always describe
        // what actually persisted.
        await l.graph.applyMcpToolAllowlist({
          agentId: agent.id,
          mcpServerId,
          grantRefs: diff.toGrant,
          revokeIds,
        });
      }
      if (delegation !== undefined && delegation !== server.delegation) {
        await l.graph.setMcpServerDelegation(mcpServerId, delegation);
      }
      if (diff.toGrant.length > 0 || toRevoke.length > 0) {
        // Same recipe as server status/ack changes: policy refresh + epoch
        // bump so the reload below actually rebuilds the agents whose MCP
        // tool surface changed.
        await refreshMcpGrantPolicy(l.graph);
        await l.graph.bumpMcpGrantEpoch(mcpServerId);
      }
      await reload(l);
      res.json({
        agentSlug,
        mcpServerId,
        ...(hasSingle
          ? { toolName: desired[0], granted: true }
          : {
              toolNames: [...diff.unchanged, ...diff.toGrant].sort(),
              granted: diff.toGrant,
              revoked: toRevoke,
            }),
        delegation: delegation ?? server.delegation,
        delegationScope: 'server',
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/mcp-grants/:grantId', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const grantId = str(req.params.grantId);
      if (!isUuid(grantId)) {
        res.status(400).json({ error: 'invalid_grant_id' });
        return;
      }
      // Scope guard (codex W8 fold): this MCP endpoint only deletes MCP tool
      // grants — never a native grant or an unrelated row, even if the caller
      // knows its id. Verify the row exists and is toolKind='mcp' first.
      const grant = (await l.graph.listAllToolGrants()).find((g) => g.id === grantId);
      if (!grant) {
        res.status(404).json({ error: 'grant_not_found' });
        return;
      }
      if (grant.toolKind !== 'mcp') {
        res.status(400).json({ error: 'not_an_mcp_grant' });
        return;
      }
      await l.graph.deleteToolGrant(grantId);
      if (grant.mcpServerId) {
        // A revoke changes the holder's tool surface: refresh the dispatch
        // policy and bump the server's grant epoch so the reload rebuilds the
        // affected agents (a bare reload can miss config-only deltas).
        await refreshMcpGrantPolicy(l.graph);
        await l.graph.bumpMcpGrantEpoch(grant.mcpServerId);
      }
      await reload(l);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // ── skill capability bindings (epic #459 W4, issue #456) ──────────────────
  router.get('/skills/:id/tool-bindings', async (req: Request, res: Response) => {
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
      const contracts = parseRequiresTools(skill.frontmatter);
      const [bindings, servers] = await Promise.all([
        l.graph.listAllSkillToolBindings(),
        l.graph.listMcpServers(),
      ]);
      const serverById = new Map(servers.map((s) => [s.id, s]));
      const bindingByContract = new Map(
        bindings.filter((b) => b.skillId === id).map((b) => [b.contract, b]),
      );
      res.json({
        contracts: contracts.map((c) => {
          const binding = bindingByContract.get(c.contract);
          return {
            contract: c.contract,
            description: c.description ?? null,
            binding: binding
              ? {
                  mcpServerId: binding.mcpServerId,
                  serverName: serverById.get(binding.mcpServerId)?.name ?? null,
                  toolName: binding.toolName,
                  boundBy: binding.boundBy,
                  boundAt: binding.boundAt.toISOString(),
                }
              : null,
          };
        }),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Bind-time gate (issue #456): binding is the point where trust is
   *  applied — same fail-closed verdict rules as tool grants. The registry
   *  graph signature includes bindings, so the reload rebuilds every agent
   *  using this skill. */
  router.put(
    '/skills/:id/tool-bindings/:contract',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const id = str(req.params.id);
        const contract = str(req.params.contract);
        if (!isUuid(id)) {
          res.status(404).json({ error: 'skill_not_found', id });
          return;
        }
        const skill = await l.graph.getSkill(id);
        if (!skill) {
          res.status(404).json({ error: 'skill_not_found', id });
          return;
        }
        if (!parseRequiresTools(skill.frontmatter).some((c) => c.contract === contract)) {
          res.status(404).json({ error: 'contract_not_declared', contract });
          return;
        }
        const actor = req.session?.sub || req.session?.email;
        if (!actor) {
          res.status(401).json({ error: 'unauthenticated' });
          return;
        }
        const mcpServerId = String(req.body?.mcpServerId ?? '');
        const toolRef = String(req.body?.toolName ?? '');
        if (!isUuid(mcpServerId) || toolRef === '') {
          res.status(400).json({ error: 'invalid_binding' });
          return;
        }
        const toolName = await assertMcpToolAllowed(l, mcpServerId, toolRef);
        await l.graph.upsertSkillToolBinding({
          skillId: id,
          contract,
          mcpServerId,
          toolName,
          boundBy: actor,
        });
        await reload(l);
        res.json({ skillId: id, contract, mcpServerId, toolName, boundBy: actor });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  router.delete(
    '/skills/:id/tool-bindings/:contract',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        await l.graph.deleteSkillToolBinding(str(req.params.id), str(req.params.contract));
        await reload(l);
        res.status(204).end();
      } catch (err) {
        fail(res, err);
      }
    },
  );

  // ── mcp marketplace (epic #459 W3, issue #455) ────────────────────────────
  router.get('/mcp-registries', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const registries = await l.graph.listMcpRegistries();
      res.json({
        registries: await Promise.all(
          registries.map(async (r) => ({
            id: r.id,
            name: r.name,
            url: r.url,
            authKind: r.authKind,
            // presence only — the token value itself never leaves the vault
            hasToken:
              r.authKind === 'bearer' && options.mcpRegistrySecrets
                ? (await options.mcpRegistrySecrets.getToken(r.id)) != null
                : false,
          })),
        ),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/mcp-registries', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const b = req.body ?? {};
      const name = String(b.name ?? '').trim();
      const url = String(b.url ?? '').trim();
      if (name === '' || !/^https?:\/\//.test(url)) {
        res.status(400).json({ error: 'invalid_registry' });
        return;
      }
      const authKind = b.authKind === 'bearer' ? 'bearer' : 'none';
      const token =
        authKind === 'bearer' && typeof b.token === 'string' && b.token !== '' ? b.token : null;
      const row = await l.graph.createMcpRegistry({ name, url, authKind });
      // Secret-at-rest: the bearer token goes to the Vault, never the DB row.
      if (token && options.mcpRegistrySecrets) {
        await options.mcpRegistrySecrets.setToken(row.id, token);
      }
      res.json({
        id: row.id,
        name: row.name,
        url: row.url,
        authKind: row.authKind,
        hasToken: token !== null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/mcp-registries/:id', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const registryId = str(req.params.id);
      await l.graph.deleteMcpRegistry(registryId);
      await options.mcpRegistrySecrets?.deleteToken(registryId);
      mcpRegistryClient.invalidate(registryId);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  /** Server-side catalog proxy: registry tokens never reach the browser. */
  router.get('/mcp-registries/:id/catalog', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const registry = (await l.graph.listMcpRegistries()).find(
        (r) => r.id === str(req.params.id),
      );
      if (!registry) {
        res.status(404).json({ error: 'mcp_registry_not_found' });
        return;
      }
      const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
      // `refresh=1` is the operator explicitly asking to re-dial: it drops both
      // the 5-minute success cache and the short "recently unreachable" note,
      // so Retry and Refresh in the UI actually hit the registry instead of
      // being answered from either cache.
      if (req.query['refresh'] === '1') mcpRegistryClient.invalidate(registry.id);
      const { entries, scope } = await mcpRegistryClient.search(
        await toRegistryConfig(registry),
        q,
      );
      // `scope` travels to the UI: a 'cached-page' result is a substring filter
      // over the browse page, not the registry's own ranking of the whole
      // catalog, and the operator has to be told so before concluding that a
      // server they expected simply is not there.
      res.json({ entries, scope });
    } catch (err) {
      if (err instanceof McpRegistryError) {
        res.status(502).json({ error: 'mcp_registry_unreachable', code: err.code, message: err.message });
        return;
      }
      fail(res, err);
    }
  });

  /** Gated import (issue #455 Phase 2): resolves the catalog entry
   *  server-side and creates the row DISABLED with full provenance — the
   *  operator then runs Discover (scan gate) and enables explicitly. */
  router.post('/mcp-servers/from-registry', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const b = req.body ?? {};
      const registryId = String(b.registryId ?? '');
      const catalogEntryId = String(b.catalogEntryId ?? '');
      const registry = (await l.graph.listMcpRegistries()).find((r) => r.id === registryId);
      if (!registry) {
        res.status(404).json({ error: 'mcp_registry_not_found' });
        return;
      }
      const entry = await mcpRegistryClient.resolve(await toRegistryConfig(registry), catalogEntryId);
      if (!entry.transport || !entry.endpoint) {
        res.status(422).json({ error: 'mcp_catalog_entry_not_importable', id: entry.id });
        return;
      }
      const row = await l.graph.createMcpServer({
        name: entry.name,
        transport: entry.transport,
        endpoint: entry.endpoint,
        status: 'disabled',
        source: 'marketplace',
        registryId,
        license: entry.license,
        author: entry.author,
        sourceUrl: entry.sourceUrl,
        configSchema: entry.configSchema ?? [],
      });
      res.json(mcpNode(row));
    } catch (err) {
      if (err instanceof McpRegistryError) {
        const status = err.code === 'catalog_entry_not_found' ? 404 : 502;
        res.status(status).json({ error: err.code, message: err.message });
        return;
      }
      fail(res, err);
    }
  });

  // ── mcp control center v2 (epic #459 W6, issue #463) ──────────────────────

  /** Test-call sandbox: execute one discovered tool directly, for operator
   *  debugging without starting an agent conversation. Runs through the
   *  router's guarded + audited McpManager, so scan-policy denials apply and
   *  every sandbox call lands in the audit log (as unattributed). */
  router.post(
    '/mcp-servers/:id/tools/:toolName/test-call',
    async (req: Request, res: Response) => {
      const l = live(res);
      if (!l) return;
      try {
        const id = str(req.params.id);
        const toolName = str(req.params.toolName);
        const server = (await l.graph.listMcpServers()).find((s) => s.id === id);
        if (!server) {
          res.status(404).json({ error: 'mcp_server_not_found' });
          return;
        }
        if (server.status === 'disabled') {
          res.status(409).json({ error: 'mcp_server_disabled' });
          return;
        }
        const args =
          req.body?.args && typeof req.body.args === 'object'
            ? (req.body.args as Record<string, unknown>)
            : {};
        const startedAt = Date.now();
        const result = await mcp.callTool(toMcpConfig(server), toolName, args);
        res.json({
          serverId: id,
          toolName,
          result,
          ok: !result.startsWith('Error:'),
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  /** Bulk re-discover + re-scan of every enabled server (#455 Phase 3). */
  router.post('/mcp-servers/rescan-all', async (_req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const result = await rescanAllMcpServers(l.graph, mcp, (m) => console.log(m));
      await reload(l);
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  // ── mcp audit log + grant matrix (epic #459 W2, issues #461/#462) ─────────
  router.get('/mcp-call-log', async (req: Request, res: Response) => {
    const l = live(res);
    if (!l) return;
    try {
      const limitRaw = Number(req.query['limit']);
      const serverIdRaw =
        typeof req.query['serverId'] === 'string' && req.query['serverId'] !== ''
          ? req.query['serverId']
          : undefined;
      const beforeIdRaw =
        typeof req.query['beforeId'] === 'string' && req.query['beforeId'] !== ''
          ? req.query['beforeId']
          : undefined;
      if (serverIdRaw !== undefined && !isUuid(serverIdRaw)) {
        res.status(400).json({ error: 'invalid_server_id' });
        return;
      }
      if (beforeIdRaw !== undefined && !/^\d+$/.test(beforeIdRaw)) {
        res.status(400).json({ error: 'invalid_before_id' });
        return;
      }
      const serverId = serverIdRaw;
      const beforeId = beforeIdRaw;
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
      const [grants, agents, subAgents, servers, verdicts, acks, bindings, pluginGrants, skills] =
        await Promise.all([
          l.graph.listAllToolGrants(),
          l.config.listAgents(),
          l.graph.listAllSubAgents(),
          l.graph.listMcpServers(),
          l.graph.listMcpToolVerdicts(CURRENT_VERIFIER_VERSION),
          l.graph.listMcpToolVerdictAcks(CURRENT_VERIFIER_VERSION),
          l.graph.listAllSkillToolBindings(),
          l.graph.listPluginMcpGrants(),
          l.graph.listSkills(),
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
            // Delegation is a per-SERVER mode (issue #862): every assignment of
            // this server acts under the same identity resolution
            // (`resolveMcpUserKey`), so the row surfaces the server's mode.
            delegation: server?.delegation ?? null,
            // Last verdict-epoch bump of this grant (set by bumpMcpGrantEpoch);
            // null until the first bump touches the row.
            grantEpoch:
              typeof g.config['verdictEpoch'] === 'string' ? g.config['verdictEpoch'] : null,
            toolName,
            severity: v?.severity ?? null,
            notYetScanned: v === undefined,
            acked: ackValid,
            blocked: v !== undefined && MCP_SEVERITIES_NEEDING_ACK.has(v.severity) && !ackValid,
          };
        });
      // Matrix extension (W6, issue #463): skill bindings (#456) and plugin
      // grants (#458) as additional holder rows, so all four caller surfaces
      // render from one response.
      const skillById = new Map(skills.map((s) => [s.id, s]));
      const bindingRows = bindings.map((b) => {
        const server = serverById.get(b.mcpServerId);
        const v = vmap.get(`${b.mcpServerId} ${b.toolName}`);
        const a = amap.get(`${b.mcpServerId} ${b.toolName}`);
        const ackValid = v !== undefined && a !== undefined && a.contentHash === v.contentHash;
        return {
          grantId: `binding:${b.skillId}:${b.contract}`,
          holderKind: 'skill' as const,
          agentSlug: null,
          agentName: skillById.get(b.skillId)?.name ?? b.skillId,
          subAgentId: null,
          subAgentName: b.contract,
          serverId: b.mcpServerId,
          serverName: server?.name ?? null,
          delegation: server?.delegation ?? null,
          grantEpoch: null,
          toolName: b.toolName,
          severity: v?.severity ?? null,
          notYetScanned: v === undefined,
          acked: ackValid,
          blocked: v !== undefined && MCP_SEVERITIES_NEEDING_ACK.has(v.severity) && !ackValid,
        };
      });
      const pluginRows = pluginGrants.map((g) => ({
        grantId: `plugin:${g.pluginId}:${g.mcpServerId}`,
        holderKind: 'plugin' as const,
        agentSlug: null,
        agentName: g.pluginId,
        subAgentId: null,
        subAgentName: null,
        serverId: g.mcpServerId,
        serverName: serverById.get(g.mcpServerId)?.name ?? null,
        delegation: serverById.get(g.mcpServerId)?.delegation ?? null,
        grantEpoch: null,
        toolName: '*',
        severity: null,
        notYetScanned: false,
        acked: false,
        blocked: false,
      }));
      res.json({ grants: [...rows, ...bindingRows, ...pluginRows] });
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

/**
 * Fail-closed MCP tool gate (issues #454/#456): the tool must have a CURRENT
 * scan verdict (an unknown ref or a pre-scan-gate discovery must be
 * re-discovered first — "never scanned" is not a bypass), and every
 * not-scanned-clean severity needs a content-hash-matching operator ack.
 * Returns the normalized bare tool name. Shared by the grant edge dispatcher
 * and the skill capability bind route.
 */
async function assertMcpToolAllowed(
  l: Live,
  mcpServerId: string,
  toolRef: string,
): Promise<string> {
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
      `mcp_tool_not_scanned: tool "${toolName}" has no current scan verdict; run Discover on server "${server.name}" first`,
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
        `mcp_tool_unacked_risk: tool "${toolName}" carries a "${verdict.severity}" scan verdict; acknowledge it in the server's tool list first`,
      );
    }
  }
  return toolName;
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
      let toolRef = String(config['toolRef'] ?? idAfter(target, 'tool'));
      const mcpServerId = (config['mcpServerId'] as string | null) ?? null;
      if (!toolRef) {
        throw new ConfigValidationError('tool_grant requires a toolRef');
      }
      // Grant gate (issue #454, fail-closed after codex review) — shared with
      // the skill-binding route (#456), see `assertMcpToolAllowed`.
      if (toolKind === 'mcp') {
        if (!mcpServerId) {
          throw new ConfigValidationError('mcp tool_grant requires an mcpServerId');
        }
        // Persist the NORMALIZED name the gate returns, not the caller's raw
        // ref: a '<serverName>:'-prefixed ref would land as its own row beside
        // the bare-name grant (the 0014 unique index keys on the raw ref),
        // splitting one tool across two rows (W0c review).
        toolRef = await assertMcpToolAllowed(l, mcpServerId, toolRef);
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
    // #1033 — the policy and what its fallback resolves to: an explicit ref
    // as `provider:model`, `auto` as the effective model, `none` as null.
    modelPolicy: a.modelPolicy ?? DEFAULT_MODEL_POLICY,
    effectiveFallback: effectiveFallbackOf(a.modelPolicy, built?.effectiveModel ?? null),
    position: a.canvasPosition ?? null,
  };
}

function effectiveFallbackOf(
  policy: AgentRow['modelPolicy'],
  effectiveModel: string | null,
): string | null {
  const fallback = (policy ?? DEFAULT_MODEL_POLICY).fallback;
  if (fallback === 'none') return null;
  if (fallback === 'auto') return effectiveModel;
  return `${fallback.provider}:${fallback.model}`;
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
  const vmap = new Map(verdicts.map((v) => [`${v.serverId}\0${v.toolName}`, v]));
  const amap = new Map(acks.map((a) => [`${a.serverId}\0${a.toolName}`, a]));
  return servers.map((s) => ({
    ...s,
    discoveredTools: (s.discoveredTools as ReadonlyArray<Record<string, unknown>>).map(
      (tool) => {
        const name = typeof tool['name'] === 'string' ? (tool['name'] as string) : '';
        const v = vmap.get(`${s.id}\0${name}`);
        const a = amap.get(`${s.id}\0${name}`);
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

/**
 * Row → API node for an MCP server. Exported for unit tests (issue #541).
 *
 * `transportDeprecated` is derived from `DEPRECATED_MCP_TRANSPORTS`, never
 * hard-coded: the web-ui uses it to badge legacy rows without duplicating the
 * spec's deprecation list. Purely additive — the row's transport is returned
 * unchanged and no DB constraint moved.
 */
export function mcpNode(s: McpServerRow) {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    /** MCP 2026-07-28 deprecated this transport (see DEPRECATED_MCP_TRANSPORTS). */
    transportDeprecated: isDeprecatedMcpTransport(s.transport),
    endpoint: s.endpoint,
    status: s.status,
    lastDiscoveredAt: s.lastDiscoveredAt ? s.lastDiscoveredAt.toISOString() : null,
    discoveredTools: s.discoveredTools,
    /** Per-server identity delegation (W0-1, D2) — the mode every assignment
     *  of this server acts under, resolved at dispatch by `resolveMcpUserKey`. */
    delegation: s.delegation,
    source: s.source,
    registryId: s.registryId,
    license: s.license,
    author: s.author,
    sourceUrl: s.sourceUrl,
    privacyBypass: s.privacyBypass,
    kgIngest: s.kgIngest,
    // Declared config fields, derived from endpoint/header placeholders when the
    // operator hasn't saved a schema yet (epic #459).
    configSchema:
      s.configSchema.length > 0 ? s.configSchema : deriveMcpConfigSchema(s.endpoint, s.headers),
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

// Single source of truth for row → connect config (substitutes non-secret
// `{key}` placeholders from row.config); epic #459.
const toMcpConfig = mcpRowToConfig;

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
