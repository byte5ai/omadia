/**
 * Agent Builder P2/P4 — hydrate an agent's orchestrator with the DomainTools
 * built from its DB-defined sub-agents (`agent_subagents` + `agent_tool_grants`
 * + `skills`).
 *
 * Bridges the registry's `ActiveAgent` graph slices into
 * `buildSubAgentDomainTools` and registers the result on the built
 * orchestrator — the same `registerDomainTool` seam the kernel uses for
 * plugin-provided domain agents. Adapters here turn:
 *   - a `mcp_servers` row → an `McpServerConfig` (header coercion), and
 *   - a native registry entry → a `LocalSubAgentTool` (so a sub-agent can call
 *     a top-level native tool that was granted to it).
 */

import {
  createAnthropicProvider,
  type AnthropicClient,
} from '@omadia/llm-adapter-anthropic';
import type { LocalSubAgentTool } from '@omadia/plugin-api';
import {
  buildSubAgentDomainTools,
  mcpNativeHandler,
  mcpToolNameFromRef,
  mcpToolToNativeSpec,
  turnContext,
  type DomainTool,
  type DomainToolSpec,
  type McpManager,
  type McpServerConfig,
  type McpServerRow,
  type McpToolDescriptor,
  type NativeToolRegistry,
  type SkillRow,
  type SkillToolBindingRow,
  type SubAgentRow,
  type ToolGrantRow,
} from '@omadia/orchestrator';

/** Minimal structural view of a BuiltOrchestrator's domain-tool surface. */
interface DomainToolHost {
  readonly orchestrator: {
    hasDomainTool(name: string): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDomainTool(tool: any): void;
  };
}

export interface SubAgentGraphSlice {
  readonly subAgents: readonly SubAgentRow[];
  readonly toolGrants: readonly ToolGrantRow[];
  readonly skills: readonly SkillRow[];
}

export interface HydrateDeps {
  readonly client: AnthropicClient;
  readonly nativeToolRegistry: NativeToolRegistry;
  readonly mcpManager: McpManager;
  readonly mcpServers: readonly McpServerRow[];
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly defaultMaxIterations?: number;
  readonly hostIsCliProvider?: boolean;
  readonly cliModelAlias?: (model: string) => string;
  /** Scan-verdict policy gate (issue #454) — see `mcpGrantPolicy.ts`. Applied
   *  to both the sub-agent grant path and the top-level DomainTool pass. */
  readonly blockedMcpGrant?: (serverId: string, toolName: string) => boolean;
  /** Persona skills attached to this agent (issue #456): skills whose
   *  frontmatter declares `requires_tools` contracts get their OPERATOR-bound
   *  MCP tools registered as DomainTools with skill attribution. */
  readonly personaSkills?: readonly SkillRow[];
  /** Operator bindings for skill capability contracts (issue #456). */
  readonly skillToolBindings?: readonly SkillToolBindingRow[];
  readonly log?: (msg: string) => void;
}

interface RequiredToolContract {
  readonly contract: string;
  readonly description?: string;
}

/** Lenient parse of a skill's `requires_tools` frontmatter (issue #456). The
 *  field is author-declared third-party data: anything malformed is dropped,
 *  never thrown on. */
export function parseRequiresTools(frontmatter: Record<string, unknown>): RequiredToolContract[] {
  const raw = frontmatter['requires_tools'];
  if (!Array.isArray(raw)) return [];
  const out: RequiredToolContract[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const contract = (item as Record<string, unknown>)['contract'];
    if (typeof contract !== 'string' || contract.trim() === '') continue;
    const description = (item as Record<string, unknown>)['description'];
    out.push({
      contract: contract.trim(),
      ...(typeof description === 'string' ? { description } : {}),
    });
  }
  return out;
}

/** Coerce a `mcp_servers` row into the client config the manager consumes. */
export function mcpRowToConfig(row: McpServerRow): McpServerConfig {
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
    ...(row.privacyBypass ? { privacyBypass: true } : {}),
  };
}

/** Adapt a top-level native tool (handler + spec) into a sub-agent tool. */
export function adaptNativeToolForSubAgent(
  registry: NativeToolRegistry,
  toolRef: string,
): LocalSubAgentTool | undefined {
  const reg = registry.get(toolRef);
  if (!reg?.handler || !reg.spec) return undefined;
  const handler = reg.handler;
  return {
    spec: {
      name: reg.spec.name,
      description: reg.spec.description,
      input_schema: {
        type: 'object',
        properties: reg.spec.input_schema.properties,
        required: [...(reg.spec.input_schema.required ?? [])],
      },
    },
    handle: (input: unknown) => handler(input),
  };
}

/** Resolve the discovered descriptor for a granted tool from the server row,
 *  so the DomainTool spec carries the real description + inputSchema. Falls
 *  back to a name-only descriptor (schema-less, still callable) when the
 *  server has not been re-discovered since the grant. */
function discoveredDescriptor(
  row: McpServerRow | undefined,
  toolRef: string,
): McpToolDescriptor {
  const tools = (row?.discoveredTools ?? []) as ReadonlyArray<Record<string, unknown>>;
  const hit = tools.find((t) => t['name'] === toolRef);
  if (hit) {
    return {
      name: toolRef,
      ...(typeof hit['description'] === 'string' ? { description: hit['description'] } : {}),
      ...(hit['inputSchema'] && typeof hit['inputSchema'] === 'object'
        ? { inputSchema: hit['inputSchema'] as Record<string, unknown> }
        : {}),
    };
  }
  return { name: toolRef };
}

/**
 * Adapt one top-level MCP tool grant into a per-agent DomainTool (epic #459
 * W0, issue #457). Composes the previously-unwired adapters: spec via
 * `mcpToolToNativeSpec`, dispatch via `mcpNativeHandler` → `McpManager.callTool`.
 * Registered on the agent's own orchestrator, NOT the process-wide
 * `NativeToolRegistry` — per-agent isolation and rebuild idempotency come from
 * the DomainTool seam (`hasDomainTool` skip guard), see the scoping decision
 * recorded on #457.
 */
export function mcpGrantToDomainTool(
  manager: McpManager,
  cfg: McpServerConfig,
  descriptor: McpToolDescriptor,
): DomainTool {
  const spec = mcpToolToNativeSpec(cfg.name, descriptor);
  const handler = mcpNativeHandler(manager, cfg, descriptor.name);
  return {
    name: spec.name,
    spec: {
      name: spec.name,
      description: spec.description,
      // MCP schemas are JSON-Schema-shaped but looser than DomainToolSpec's
      // property map; the orchestrator forwards specs verbatim to the LLM, so
      // the structural cast is safe here.
      input_schema: spec.input_schema as DomainToolSpec['input_schema'],
    },
    domain: spec.domain ?? `mcp.${cfg.name}`,
    // Stable key for the LIVE per-server privacy-bypass lookup (see
    // mcpPrivacyBypass.ts). Baked once; the bypass decision itself is read live.
    mcpServerId: cfg.id,
    handle: (input: unknown) => handler(input),
  };
}

/**
 * Build + register the sub-agent DomainTools for one agent. Returns the number
 * of tools newly registered (skips names already present so it is safe to call
 * on both initial hydrate and post-rebuild).
 */
export function registerDbSubAgentTools(
  slice: SubAgentGraphSlice,
  built: DomainToolHost,
  deps: HydrateDeps,
): number {
  // Disabled servers never materialize tools — neither for sub-agents nor
  // top-level grants (codex W2 finding: status was ignored end to end).
  const mcpServersById = new Map<string, McpServerConfig>(
    deps.mcpServers
      .filter((r) => r.status !== 'disabled')
      .map((r) => [r.id, mcpRowToConfig(r)]),
  );
  const tools: DomainTool[] =
    slice.subAgents.length === 0
      ? []
      : buildSubAgentDomainTools(slice, {
          provider: createAnthropicProvider({ client: deps.client }),
          defaultModel: deps.defaultModel,
          defaultMaxTokens: deps.defaultMaxTokens ?? 4096,
          defaultMaxIterations: deps.defaultMaxIterations ?? 8,
          mcpManager: deps.mcpManager,
          mcpServersById,
          nativeTool: (ref) => adaptNativeToolForSubAgent(deps.nativeToolRegistry, ref),
          ...(deps.blockedMcpGrant ? { blockedMcpGrant: deps.blockedMcpGrant } : {}),
          ...(deps.hostIsCliProvider !== undefined
            ? { hostIsCliProvider: deps.hostIsCliProvider }
            : {}),
          ...(deps.cliModelAlias !== undefined
            ? { cliModelAlias: deps.cliModelAlias }
            : {}),
          ...(deps.log ? { log: deps.log } : {}),
        });

  // Top-level grants (epic #459 W0, issue #457): rows with agentId set and
  // subAgentId null were persisted by the Builder but never materialized —
  // `buildSubAgentDomainTools` correctly skips them (they belong to no
  // sub-agent bucket). Register each MCP grant as a per-agent DomainTool.
  // `toolKind='native'` top-level grants stay a no-op: native tools are
  // process-wide and already reachable by the orchestrator.
  for (const g of slice.toolGrants) {
    if (g.subAgentId !== null) continue;
    if (g.toolKind !== 'mcp' || !g.mcpServerId) continue;
    const cfg = mcpServersById.get(g.mcpServerId);
    if (!cfg) {
      deps.log?.(
        `subAgentToolHydration: top-level grant "${g.toolRef}" references unknown mcp server ${g.mcpServerId}, skipped`,
      );
      continue;
    }
    const toolName = mcpToolNameFromRef(g.toolRef, cfg.name);
    if (deps.blockedMcpGrant?.(g.mcpServerId, toolName)) {
      deps.log?.(
        `subAgentToolHydration: top-level mcp tool "${toolName}" on "${cfg.name}" blocked by scan-verdict policy — skipped`,
      );
      continue;
    }
    const row = deps.mcpServers.find((r) => r.id === g.mcpServerId);
    tools.push(
      mcpGrantToDomainTool(deps.mcpManager, cfg, discoveredDescriptor(row, toolName)),
    );
  }

  // Skill capability contracts (epic #459 W4, issue #456): persona skills may
  // declare `requires_tools`; only OPERATOR-bound contracts materialize, and
  // unbound contracts fail closed (skill text attaches, capability absent).
  // Calls run with skill attribution so the audit log names the skill.
  const bindingByKey = new Map(
    (deps.skillToolBindings ?? []).map((b) => [`${b.skillId} ${b.contract}`, b]),
  );
  for (const skill of deps.personaSkills ?? []) {
    for (const required of parseRequiresTools(skill.frontmatter)) {
      const binding = bindingByKey.get(`${skill.id} ${required.contract}`);
      if (!binding) {
        deps.log?.(
          `subAgentToolHydration: skill "${skill.slug}" contract "${required.contract}" is unbound — capability absent (fail closed)`,
        );
        continue;
      }
      const cfg = mcpServersById.get(binding.mcpServerId);
      if (!cfg) {
        deps.log?.(
          `subAgentToolHydration: skill "${skill.slug}" binding "${required.contract}" references unknown/disabled server ${binding.mcpServerId} — skipped`,
        );
        continue;
      }
      if (deps.blockedMcpGrant?.(binding.mcpServerId, binding.toolName)) {
        deps.log?.(
          `subAgentToolHydration: skill-bound mcp tool "${binding.toolName}" on "${cfg.name}" blocked by scan-verdict policy — skipped`,
        );
        continue;
      }
      const row = deps.mcpServers.find((r) => r.id === binding.mcpServerId);
      const base = mcpGrantToDomainTool(
        deps.mcpManager,
        cfg,
        discoveredDescriptor(row, binding.toolName),
      );
      const skillSlug = skill.slug;
      const skillId = skill.id;
      tools.push({
        ...base,
        handle: (input: unknown) => {
          const current = turnContext.current();
          // Bind-time consent covers "when this skill is active" — a turn
          // where a DIFFERENT (or no) persona is acting must not reach the
          // tool, even though it is registered on the agent (codex fold).
          if (current?.activePersonaSkillId !== skillId) {
            return Promise.resolve(
              `Error: tool "${base.name}" is bound to skill "${skillSlug}", which is not the active persona for this turn.`,
            );
          }
          // Attribute the call to the skill in the audit log (issue #462
          // taxonomy) while inheriting the rest of the active turn context.
          return turnContext.run(
            {
              turnId: current.turnId,
              turnDate: current.turnDate,
              ...(current.agentSlug ? { agentSlug: current.agentSlug } : {}),
              ...(current.privacyHandle ? { privacyHandle: current.privacyHandle } : {}),
              activePersonaSkillId: skillId,
              mcpCallerKind: 'skill',
              mcpCallerId: skillSlug,
            },
            () => base.handle(input),
          );
        },
      });
    }
  }

  let n = 0;
  for (const t of tools) {
    if (!built.orchestrator.hasDomainTool(t.name)) {
      built.orchestrator.registerDomainTool(t);
      n += 1;
    } else if (t.domain.startsWith('mcp.')) {
      // A fresh rebuild starts from an empty tool surface, so a hit here means
      // another tool already claimed this (sanitized, possibly truncated)
      // name — surface it instead of silently dropping the grant (codex
      // finding: collisions were invisible).
      deps.log?.(
        `subAgentToolHydration: mcp tool name "${t.name}" already registered — grant not materialized (name collision)`,
      );
    }
  }
  return n;
}
