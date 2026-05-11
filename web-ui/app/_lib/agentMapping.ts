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

const TOOL_NAME_TO_AGENT: Record<string, AgentMeta> = {
  query_confluence_playbook: {
    id: 'de.byte5.agent.confluence',
    label: 'Confluence',
    tone: 'cyan',
  },
  query_odoo_hr: {
    id: 'de.byte5.agent.odoo-hr',
    label: 'Odoo HR',
    tone: 'navy',
  },
  query_odoo_accounting: {
    id: 'de.byte5.agent.odoo-accounting',
    label: 'Odoo Accounting',
    tone: 'navy',
  },
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
