// MCP tools as Conductor action ids.
//
// The action catalog is a flat list of string ids (`webhook.post`, plugin
// deterministic-action tool names). MCP tools join it under a prefixed id so a
// Designer action step can name one without the engine learning anything about
// MCP: `mcp:<serverId>:<toolName>`. The server id is a uuid (never contains
// `:`), so the first two colons delimit and a tool name may itself contain `:`.

export const MCP_ACTION_PREFIX = 'mcp:';

export interface McpActionRef {
  readonly serverId: string;
  readonly toolName: string;
}

export function mcpActionId(serverId: string, toolName: string): string {
  return `${MCP_ACTION_PREFIX}${serverId}:${toolName}`;
}

/** `mcp:<serverId>:<toolName>` → parts; null for any other id (or a malformed one). */
export function parseMcpActionId(actionId: string): McpActionRef | null {
  if (!actionId.startsWith(MCP_ACTION_PREFIX)) return null;
  const rest = actionId.slice(MCP_ACTION_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const serverId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 1);
  if (toolName.length === 0) return null;
  return { serverId, toolName };
}
