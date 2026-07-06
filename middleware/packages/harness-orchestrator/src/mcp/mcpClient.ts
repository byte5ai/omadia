/**
 * MCP client manager (Agent Builder P4).
 *
 * Connects to operator-registered MCP servers (stdio / streamable-HTTP / SSE)
 * via the official `@modelcontextprotocol/sdk`, discovers their tools, and
 * adapts each discovered tool into the two shapes the orchestrator already
 * understands:
 *
 *   - `NativeToolSpec` + `NativeToolHandler` — for tools granted to a
 *     top-level agent (registered on its `NativeToolRegistry`).
 *   - `LocalSubAgentTool`               — for tools granted to a sub-agent
 *     (passed into its `LocalSubAgent` tool list).
 *
 * Connections are pooled per server id and lazily (re)established. A failed
 * connection is dropped so the next call retries — callers layer their own
 * backoff. The manager never throws on `callTool`; it returns an `Error: …`
 * string so a tool failure degrades the turn instead of killing it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  LocalSubAgentTool,
  NativeToolHandler,
  NativeToolSpec,
} from '@omadia/plugin-api';

import { turnContext } from '../turnContext.js';

export type McpTransportKind = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransportKind;
  /** URL for http/sse, or a shell command line for stdio. */
  readonly endpoint: string | null;
  /** Non-sensitive headers for http/sse. Secrets resolve via `secretRef`. */
  readonly headers?: Record<string, string>;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** Caller taxonomy for the MCP call audit log (epic #459 W2, issue #462).
 *  Defined once here; skill (#456) and plugin (#458) surfaces identify
 *  themselves via `turnContext.mcpCallerKind`. */
export type McpCallerKind = 'agent' | 'subagent' | 'skill' | 'plugin' | 'unattributed';

/** One audit entry per `callTool` invocation. Deliberately carries NO tool
 *  arguments — identity and outcome only. */
export interface McpCallLogEntry {
  readonly serverId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly callerKind: McpCallerKind;
  readonly callerAgent: string | null;
  readonly turnId: string | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly durationMs: number;
  readonly calledAt: Date;
}

/** Observer invoked after every tool call. Implementations must be fast and
 *  MUST NOT throw; the manager additionally guards with try/catch so the
 *  audit path can never break a tool call. */
export type McpCallObserver = (entry: McpCallLogEntry) => void;

/** Dispatch-time policy gate (issue #454, codex-fold 2). Returns a
 *  model-facing error string to DENY the call, or null to allow it. Runs on
 *  every `callTool`, so policy changes (re-discover found a risk, operator
 *  acked one) apply immediately — no registry rebuild required for
 *  enforcement. Denied calls are still audit-logged. */
export type McpCallGuard = (serverId: string, toolName: string) => string | null;

export interface McpManagerOptions {
  readonly onToolCall?: McpCallObserver;
  readonly guard?: McpCallGuard;
}

interface Pooled {
  readonly client: Client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly transport: any;
}

const CLIENT_INFO = { name: 'omadia-agent-builder', version: '0.1.0' } as const;

export class McpManager {
  private readonly pool = new Map<string, Pooled>();
  private readonly connecting = new Map<string, Promise<Pooled>>();

  /** Optional audit observer + dispatch guard (issues #462/#454). Existing
   *  `new McpManager()` call sites keep working unchanged. */
  constructor(private readonly options?: McpManagerOptions) {}

  /** Emit one audit entry. Caller identity comes from the turn context
   *  (AsyncLocalStorage), so every dispatch path is covered without call-site
   *  threading; non-turn paths degrade deterministically to `unattributed`.
   *  Never throws into the tool-call path. */
  private emitCall(
    cfg: McpServerConfig,
    toolName: string,
    ok: boolean,
    error: string | null,
    startedAt: number,
  ): void {
    if (!this.options?.onToolCall) return;
    try {
      const ctx = turnContext.current();
      const inTurn = ctx !== undefined && ctx.turnId !== '';
      const callerKind: McpCallerKind =
        ctx?.mcpCallerKind ??
        (ctx?.subAgentOwnerPluginId !== undefined
          ? 'subagent'
          : inTurn
            ? 'agent'
            : 'unattributed');
      this.options.onToolCall({
        serverId: cfg.id,
        serverName: cfg.name,
        toolName,
        callerKind,
        callerAgent: ctx?.mcpCallerId ?? ctx?.agentSlug ?? null,
        turnId: inTurn ? ctx.turnId : null,
        ok,
        // Bounded: external error strings can carry upstream data; the audit
        // table is append-only, so cap what gets persisted (codex W2 finding).
        error: error === null ? null : error.length > 300 ? `${error.slice(0, 300)}…` : error,
        durationMs: Date.now() - startedAt,
        calledAt: new Date(),
      });
    } catch {
      /* the audit trail must never break a tool call */
    }
  }

  /** Discover the tool list a server exposes. Throws on connection failure so
   *  the operator-facing `/discover` endpoint can report it. */
  async listTools(cfg: McpServerConfig): Promise<McpToolDescriptor[]> {
    const { client } = await this.getOrConnect(cfg);
    const res = await client.listTools();
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools.map((t) => ({
      name: String(t.name),
      ...(t.description ? { description: String(t.description) } : {}),
      ...(t.inputSchema
        ? { inputSchema: t.inputSchema as Record<string, unknown> }
        : {}),
    }));
  }

  /** Invoke a tool. Never throws — returns an `Error: …` string on failure so
   *  the orchestrator turn keeps going. */
  async callTool(
    cfg: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const startedAt = Date.now();
    // Dispatch-time policy gate (issue #454): checked on EVERY call, so a
    // verdict that turned risky on re-discover blocks immediately and an
    // operator ack unblocks immediately — independent of registry rebuilds.
    try {
      const denial = this.options?.guard?.(cfg.id, toolName);
      if (denial) {
        this.emitCall(cfg, toolName, false, denial, startedAt);
        return denial;
      }
    } catch {
      /* a broken guard must not take down tool dispatch — fall through */
    }
    let pooled: Pooled;
    try {
      pooled = await this.getOrConnect(cfg);
    } catch (err) {
      const failure = `Error: could not connect to MCP server "${cfg.name}": ${msg(err)}`;
      this.emitCall(cfg, toolName, false, failure, startedAt);
      return failure;
    }
    try {
      const res = await pooled.client.callTool({
        name: toolName,
        arguments: args,
      });
      const rendered = renderToolResult(res);
      // MCP protocol errors resolve (isError result) instead of throwing —
      // the audit row must reflect the failure (codex W2 finding).
      const protocolError =
        res !== null && typeof res === 'object' && (res as { isError?: unknown }).isError === true;
      this.emitCall(cfg, toolName, !protocolError, protocolError ? rendered : null, startedAt);
      return rendered;
    } catch (err) {
      // Drop the connection so the next call reconnects (server may have died).
      await this.close(cfg.id);
      const failure = `Error: MCP tool "${toolName}" on "${cfg.name}" failed: ${msg(err)}`;
      this.emitCall(cfg, toolName, false, failure, startedAt);
      return failure;
    }
  }

  async close(id: string): Promise<void> {
    const pooled = this.pool.get(id);
    this.pool.delete(id);
    this.connecting.delete(id);
    if (!pooled) return;
    try {
      await pooled.client.close();
    } catch {
      /* best-effort */
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pool.keys()].map((id) => this.close(id)));
  }

  private getOrConnect(cfg: McpServerConfig): Promise<Pooled> {
    const existing = this.pool.get(cfg.id);
    if (existing) return Promise.resolve(existing);
    const inflight = this.connecting.get(cfg.id);
    if (inflight) return inflight;

    const p = this.connect(cfg)
      .then((pooled) => {
        this.pool.set(cfg.id, pooled);
        this.connecting.delete(cfg.id);
        return pooled;
      })
      .catch((err) => {
        this.connecting.delete(cfg.id);
        throw err;
      });
    this.connecting.set(cfg.id, p);
    return p;
  }

  private async connect(cfg: McpServerConfig): Promise<Pooled> {
    const transport = this.makeTransport(cfg);
    const client = new Client(CLIENT_INFO);
    await client.connect(transport);
    return { client, transport };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private makeTransport(cfg: McpServerConfig): any {
    if (!cfg.endpoint) {
      throw new Error(`MCP server "${cfg.name}" has no endpoint configured`);
    }
    if (cfg.transport === 'stdio') {
      const [command, ...args] = splitCommand(cfg.endpoint);
      if (!command) {
        throw new Error(`MCP server "${cfg.name}" stdio command is empty`);
      }
      return new StdioClientTransport({ command, args });
    }
    const url = new URL(cfg.endpoint);
    const requestInit = cfg.headers ? { headers: cfg.headers } : undefined;
    if (cfg.transport === 'sse') {
      return new SSEClientTransport(url, requestInit ? { requestInit } : {});
    }
    return new StreamableHTTPClientTransport(
      url,
      requestInit ? { requestInit } : {},
    );
  }
}

// ── adapters ────────────────────────────────────────────────────────────────

/** Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Build a stable,
 *  collision-resistant native name for an MCP tool. */
export function mcpNativeToolName(
  serverName: string,
  toolName: string,
): string {
  const raw = `mcp__${serverName}__${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.length <= 64 ? safe : safe.slice(0, 64);
}

function inputSchemaOrEmpty(tool: McpToolDescriptor): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const schema = tool.inputSchema;
  if (schema && schema['type'] === 'object') {
    return {
      type: 'object',
      properties: (schema['properties'] as Record<string, unknown>) ?? {},
      required: Array.isArray(schema['required'])
        ? (schema['required'] as string[])
        : [],
    };
  }
  return { type: 'object', properties: {}, required: [] };
}

/** Adapt an MCP tool into a top-level orchestrator NativeToolSpec. */
export function mcpToolToNativeSpec(
  serverName: string,
  tool: McpToolDescriptor,
): NativeToolSpec {
  return {
    name: mcpNativeToolName(serverName, tool.name),
    description:
      tool.description ?? `MCP tool "${tool.name}" from server "${serverName}".`,
    input_schema: inputSchemaOrEmpty(tool),
    domain: `mcp.${slugifyDomain(serverName)}`,
  };
}

/** Native handler that routes a tool call to the MCP server. */
export function mcpNativeHandler(
  manager: McpManager,
  cfg: McpServerConfig,
  toolName: string,
): NativeToolHandler {
  return async (input: unknown): Promise<string> => {
    const args =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    return manager.callTool(cfg, toolName, args);
  };
}

/** Adapt an MCP tool into a sub-agent tool (for `LocalSubAgent`). */
export function mcpToolToLocalSubAgentTool(
  manager: McpManager,
  cfg: McpServerConfig,
  tool: McpToolDescriptor,
): LocalSubAgentTool {
  return {
    spec: {
      name: mcpNativeToolName(cfg.name, tool.name),
      description:
        tool.description ?? `MCP tool "${tool.name}" from "${cfg.name}".`,
      input_schema: inputSchemaOrEmpty(tool),
    },
    async handle(input: unknown): Promise<string> {
      const args =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      return manager.callTool(cfg, tool.name, args);
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Flatten an MCP `CallToolResult` into a plain string for the LLM. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderToolResult(res: any): string {
  const content = res?.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block?.type === 'resource' && block.resource?.text) {
        parts.push(String(block.resource.text));
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    const joined = parts.join('\n').trim();
    const out = joined.length > 0 ? joined : JSON.stringify(content);
    return res?.isError ? `Error: ${out}` : out;
  }
  if (typeof res?.structuredContent !== 'undefined') {
    return JSON.stringify(res.structuredContent);
  }
  return JSON.stringify(res ?? {});
}

/** Split a shell command line into argv. Honours simple double/single quotes;
 *  not a full shell parser, but enough for `npx -y @scope/pkg --flag "v"`. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function slugifyDomain(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'server';
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
