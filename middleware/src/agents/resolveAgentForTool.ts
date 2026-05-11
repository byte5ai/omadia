/**
 * Server-side `tool name → AgentMeta` resolver consumed by the chat route to
 * decorate `tool_use` events. The frontend reads `event.agent` directly when
 * rendering the per-session agent pills, instead of carrying a hardcoded
 * lookup table that has to be edited every time a Builder agent ships.
 *
 * Resolution strategy: tools that map to an installed dynamic/Builder agent
 * are resolved through `DynamicAgentRuntime.findAgentIdByToolName`. Label
 * derives from the agent id's last segment (e.g. `@org/agent-seo-analyst` →
 * "seo-analyst" → "Seo Analyst"); tone comes from a deterministic
 * agent-id hash. Helper / built-in tools without a backing agent (memory,
 * ask_user_choice, render_diagram, suggest_follow_ups, …) return
 * `undefined` and the UI skips the pill.
 *
 * Custom built-in pairings (e.g. calendar tools belonging to a single
 * synthetic agent) can be plugged in via the optional `customResolver`
 * passed to `createAgentResolver`.
 */

import type { AgentMeta } from '@omadia/channel-sdk';

import type { DynamicAgentRuntime } from '../plugins/dynamicAgentRuntime.js';

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
    const dynamicAgentId = deps.dynamicRuntime?.findAgentIdByToolName(toolName);
    if (!dynamicAgentId) return undefined;

    return {
      id: dynamicAgentId,
      label: labelFromAgentId(dynamicAgentId),
      tone: toneForDynamicAgent(dynamicAgentId),
    };
  };
}
