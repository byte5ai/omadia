/**
 * The tabs of the agent page and the parser of `?tab=`. Plain module, no
 * 'use client': the page (a server component) reads `?tab=` with
 * `parseAgentDetailTab`, so the server renders the tab the client hydrates.
 */
export const AGENT_DETAIL_TABS = [
  'identity',
  'model',
  'peers',
  'teams',
  // #2066 — facilitators only: which facilitation engine it runs on.
  'engine',
  // #2060, #2066 — facilitators only: default methods, reminders and
  // moderation working modes.
  'moderation',
  'plugins',
  'tools',
  'memory',
] as const;

export type AgentDetailTab = (typeof AGENT_DETAIL_TABS)[number];

export const DEFAULT_AGENT_DETAIL_TAB: AgentDetailTab = 'identity';

export function parseAgentDetailTab(raw: string | null | undefined): AgentDetailTab {
  return (AGENT_DETAIL_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as AgentDetailTab)
    : DEFAULT_AGENT_DETAIL_TAB;
}
