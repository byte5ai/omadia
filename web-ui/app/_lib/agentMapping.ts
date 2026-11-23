/**
 * Mapping from orchestrator domain-tool names to installed-agent metadata.
 *
 * This is a transitional, hard-coded lookup. Once Slice 1.3 ships the
 * Installed-Agents API (`GET /api/v1/agents`), the Chat UI should fetch
 * this mapping dynamically and drop the static file. Until then we keep
 * it hand-maintained to avoid adding a new endpoint just for pills.
 *
 * NOTE: only agents backed by an installed plugin belong here. Orchestrator
 * helper tools (ask_user_choice, suggest_follow_ups, render_diagram, …) are
 * deliberately NOT in the table — they shouldn't show up as agent pills.
 */

export interface AgentMeta {
  id: string;
  label: string;
  tone: 'cyan' | 'navy' | 'magenta' | 'warning';
}

// Spec 2042 §5.10 (S3c) — the retired agent plugins' `query_*` tools are gone;
// a plugin tool's pill comes from the server (`tool_use.agent`).
const TOOL_NAME_TO_AGENT: Record<string, AgentMeta> = {
  find_free_slots: {
    id: 'de.byte5.agent.calendar',
    label: 'Calendar',
    tone: 'cyan',
  },
  book_meeting: {
    id: 'de.byte5.agent.calendar',
    label: 'Calendar',
    tone: 'cyan',
  },
};

export function agentForToolName(name: string): AgentMeta | undefined {
  return TOOL_NAME_TO_AGENT[name];
}
