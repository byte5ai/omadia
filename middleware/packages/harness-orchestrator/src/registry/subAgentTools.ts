import type Anthropic from '@anthropic-ai/sdk';
import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { LocalSubAgent } from '../localSubAgent.js';
import type {
  McpManager} from '../mcp/mcpClient.js';
import {
  mcpToolToLocalSubAgentTool,
  type McpServerConfig,
} from '../mcp/mcpClient.js';
import { createDomainTool, type DomainTool } from '../tools/domainQueryTool.js';

import type {
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from './agentGraphStore.js';

/**
 * Agent Builder P2/P4 — materialise an agent's DB-defined sub-agents into
 * orchestrator `DomainTool`s.
 *
 * Each enabled `agent_subagents` row becomes a `LocalSubAgent` whose system
 * prompt is its skill body (or an inline override), running on its own model
 * with the tools granted to it (native tools resolved via the orchestrator's
 * registry, MCP tools via the `McpManager`). The sub-agent is wrapped in a
 * `DomainTool` (`ask_<name>`) so the parent orchestrator can delegate to it by
 * tool name — the same mechanism plugin-provided domain agents use.
 *
 * Pure-ish factory: the only side effect is constructing `LocalSubAgent` /
 * MCP-tool closures. Unit-testable by passing a fake client + resolvers.
 */

export interface SubAgentGraph {
  readonly subAgents: readonly SubAgentRow[];
  readonly toolGrants: readonly ToolGrantRow[];
  readonly skills: readonly SkillRow[];
}

export interface SubAgentToolDeps {
  readonly client: Anthropic;
  readonly defaultModel: string;
  readonly defaultMaxTokens: number;
  readonly defaultMaxIterations: number;
  /** Resolves an MCP server id → connection config (for mcp tool grants). */
  readonly mcpServersById?: ReadonlyMap<string, McpServerConfig>;
  /** Shared MCP connection pool. Required to honour mcp tool grants. */
  readonly mcpManager?: McpManager;
  /** Resolves a native tool name → a sub-agent-callable tool, if available. */
  readonly nativeTool?: (toolRef: string) => LocalSubAgentTool | undefined;
  readonly log?: (msg: string) => void;
}

export function buildSubAgentDomainTools(
  graph: SubAgentGraph,
  deps: SubAgentToolDeps,
): DomainTool[] {
  const skillsById = new Map(graph.skills.map((s) => [s.id, s]));
  const grantsBySubAgent = new Map<string, ToolGrantRow[]>();
  for (const g of graph.toolGrants) {
    if (!g.subAgentId) continue;
    const list = grantsBySubAgent.get(g.subAgentId);
    if (list) list.push(g);
    else grantsBySubAgent.set(g.subAgentId, [g]);
  }

  const tools: DomainTool[] = [];
  for (const sub of graph.subAgents) {
    if (sub.status !== 'enabled') continue;

    const skillBody = sub.skillId
      ? skillsById.get(sub.skillId)?.body
      : undefined;
    const systemPrompt =
      sub.systemPromptOverride?.trim() ||
      skillBody?.trim() ||
      `You are the "${sub.name}" sub-agent. Answer the delegated question precisely using your available tools.`;

    const subTools = resolveSubAgentTools(
      grantsBySubAgent.get(sub.id) ?? [],
      deps,
    );

    const local = new LocalSubAgent({
      name: sub.name,
      client: deps.client,
      model: sub.model ?? deps.defaultModel,
      maxTokens: sub.maxTokens ?? deps.defaultMaxTokens,
      maxIterations: sub.maxIterations ?? deps.defaultMaxIterations,
      systemPrompt,
      tools: subTools,
    });

    tools.push(
      createDomainTool({
        name: subAgentToolName(sub.name),
        description: `Delegate a focused question to the "${sub.name}" sub-agent.`,
        agent: local,
        domain: `subagent.${slugifyDomain(sub.name)}`,
      }),
    );
  }
  return tools;
}

function resolveSubAgentTools(
  grants: readonly ToolGrantRow[],
  deps: SubAgentToolDeps,
): LocalSubAgentTool[] {
  const out: LocalSubAgentTool[] = [];
  for (const g of grants) {
    if (g.toolKind === 'native') {
      const t = deps.nativeTool?.(g.toolRef);
      if (t) out.push(t);
      else deps.log?.(`sub-agent tool: native tool "${g.toolRef}" not resolvable — skipped`);
      continue;
    }
    // mcp
    if (!g.mcpServerId || !deps.mcpManager || !deps.mcpServersById) {
      deps.log?.(`sub-agent tool: mcp grant "${g.toolRef}" missing manager/server — skipped`);
      continue;
    }
    const cfg = deps.mcpServersById.get(g.mcpServerId);
    if (!cfg) {
      deps.log?.(`sub-agent tool: mcp server ${g.mcpServerId} not found — skipped`);
      continue;
    }
    const toolName = mcpToolNameFromRef(g.toolRef, cfg.name);
    out.push(
      mcpToolToLocalSubAgentTool(deps.mcpManager, cfg, { name: toolName }),
    );
  }
  return out;
}

/** `toolRef` for an mcp grant is "<serverName>:<toolName>"; fall back to the
 *  whole ref when it isn't prefixed. */
export function mcpToolNameFromRef(toolRef: string, serverName: string): string {
  const prefix = `${serverName}:`;
  if (toolRef.startsWith(prefix)) return toolRef.slice(prefix.length);
  const idx = toolRef.indexOf(':');
  return idx >= 0 ? toolRef.slice(idx + 1) : toolRef;
}

/** `ask_<slug>` constrained to Anthropic's tool-name charset (`[a-zA-Z0-9_-]{1,64}`). */
export function subAgentToolName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const full = `ask_${slug || 'subagent'}`;
  return full.length <= 64 ? full : full.slice(0, 64);
}

/** Lowercase dotted-domain segment (matches PLUGIN_DOMAIN_REGEX once prefixed). */
function slugifyDomain(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (s.length === 0) s = 'agent';
  if (!/^[a-z]/.test(s)) s = `a${s}`;
  return s;
}
