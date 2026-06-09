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

import type Anthropic from '@anthropic-ai/sdk';
import type { LocalSubAgentTool } from '@omadia/plugin-api';
import {
  buildSubAgentDomainTools,
  type McpManager,
  type McpServerConfig,
  type McpServerRow,
  type NativeToolRegistry,
  type SkillRow,
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
  readonly client: Anthropic;
  readonly nativeToolRegistry: NativeToolRegistry;
  readonly mcpManager: McpManager;
  readonly mcpServers: readonly McpServerRow[];
  readonly defaultModel: string;
  readonly defaultMaxTokens?: number;
  readonly defaultMaxIterations?: number;
  readonly log?: (msg: string) => void;
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
  if (slice.subAgents.length === 0) return 0;
  const mcpServersById = new Map<string, McpServerConfig>(
    deps.mcpServers.map((r) => [r.id, mcpRowToConfig(r)]),
  );
  const tools = buildSubAgentDomainTools(slice, {
    client: deps.client,
    defaultModel: deps.defaultModel,
    defaultMaxTokens: deps.defaultMaxTokens ?? 4096,
    defaultMaxIterations: deps.defaultMaxIterations ?? 8,
    mcpManager: deps.mcpManager,
    mcpServersById,
    nativeTool: (ref) => adaptNativeToolForSubAgent(deps.nativeToolRegistry, ref),
    ...(deps.log ? { log: deps.log } : {}),
  });
  let n = 0;
  for (const t of tools) {
    if (!built.orchestrator.hasDomainTool(t.name)) {
      built.orchestrator.registerDomainTool(t);
      n += 1;
    }
  }
  return n;
}
