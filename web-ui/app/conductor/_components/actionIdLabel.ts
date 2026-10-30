/**
 * Human-readable label for a Conductor action id. MCP tools join the action
 * catalog as `mcp:<serverId>:<toolName>` — a uuid in the middle is noise on a
 * canvas node, so the label shows the tool name plus an "MCP" marker. Every
 * other id (webhook.post, plugin tool names) is shown verbatim.
 */
export const MCP_ACTION_PREFIX = 'mcp:';

export function describeActionId(actionId: string): { label: string; isMcp: boolean } {
  if (!actionId.startsWith(MCP_ACTION_PREFIX)) return { label: actionId, isMcp: false };
  const rest = actionId.slice(MCP_ACTION_PREFIX.length);
  const sep = rest.indexOf(':');
  const toolName = sep >= 0 ? rest.slice(sep + 1) : rest;
  return { label: toolName.length > 0 ? toolName : actionId, isMcp: true };
}
