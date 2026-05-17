/**
 * Server-side `tool name → AgentMeta` resolver consumed by the chat route to
 * decorate `tool_use` events. The frontend reads `event.agent` directly when
 * rendering the per-session agent pills, instead of carrying a hardcoded
 * lookup table that has to be edited every time a Builder agent ships.
 *
 * Two sources are merged:
 *   1. Built-in agents (Confluence, Odoo HR/Accounting, Calendar) — curated
 *      tones to match the byte5 brand pairing the design team agreed on.
 *   2. Dynamic / Builder-uploaded agents — id comes from
 *      `DynamicAgentRuntime.findAgentIdByToolName`, label from the agent id's
 *      last dot-segment (`de.byte5.agent.wanderlust-concierge` →
 *      "Wanderlust Concierge"), tone from a deterministic agent-id hash.
 *
 * Helper / built-in tools without a backing agent (memory, ask_user_choice,
 * render_diagram, suggest_follow_ups, …) return `undefined` and the UI
 * skips the pill.
 */

import type { AgentMeta } from '@omadia/channel-sdk';

import type { DynamicAgentRuntime } from '../plugins/dynamicAgentRuntime.js';

const BUILT_IN_TOOL_TO_AGENT: Record<string, AgentMeta> = {
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

const DYNAMIC_TONES: AgentMeta['tone'][] = ['magenta', 'warning', 'cyan', 'navy'];

function hashAgentId(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (Math.imul(hash, 31) + agentId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function toneForDynamicAgent(agentId: string): AgentMeta['tone'] {
  // Length is non-zero by construction; index modulo length is always
  // in-bounds. Asserted so the optional element type collapses for strict.
  return DYNAMIC_TONES[hashAgentId(agentId) % DYNAMIC_TONES.length] as AgentMeta['tone'];
}

function labelFromAgentId(agentId: string): string {
  // Split on `.` (legacy `de.byte5.agent.X`) or `/` (post-Welle-1 `@omadia/X`)
  // so the npm-scope namespace doesn't bleed into the UI label.
  const last = agentId.split(/[./]/).pop() ?? agentId;
  if (!last) return agentId;
  return last
    .split(/[-_]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export type AgentResolver = (toolName: string) => AgentMeta | undefined;

export interface AgentResolverDeps {
  dynamicRuntime?: DynamicAgentRuntime;
}

export function createAgentResolver(deps: AgentResolverDeps): AgentResolver {
  return (toolName: string): AgentMeta | undefined => {
    const builtIn = BUILT_IN_TOOL_TO_AGENT[toolName];
    if (builtIn) return builtIn;

    const dynamicAgentId = deps.dynamicRuntime?.findAgentIdByToolName(toolName);
    if (!dynamicAgentId) return undefined;

    return {
      id: dynamicAgentId,
      label: labelFromAgentId(dynamicAgentId),
      tone: toneForDynamicAgent(dynamicAgentId),
    };
  };
}
