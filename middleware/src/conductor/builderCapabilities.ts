// Builder capability awareness — "this draft names something nobody can run".
//
// Computed BESIDE `validate()` on purpose. The engine's `unknown_action_ref`
// says "graph invalid"; what the operator needs to hear is "graph fine, a
// connector is not connected yet — connect it inline". Routing the signal
// through validation would also arm the builder's self-correction retry, which
// would dutifully delete the placeholder step (the thing we want to surface).
// The source of truth is the same list `invokeAction` dispatches on
// (`listActions`), so the signal and the runtime cannot disagree.

import type { WorkflowGraph } from '@omadia/conductor-core';

export interface MissingCapability {
  stepId: string;
  kind: 'action' | 'agent';
  /** the unresolved id as the agent wrote it, e.g. `pleo.list_missing_receipts`. */
  ref: string;
  /** registry search seed: the segment before the first `.`/`:`, lowercased. */
  suggestedQuery: string;
}

export interface KnownIds {
  /** undefined ⇒ unknown set ⇒ nothing is reported missing (validate()'s KnownRefs rule). */
  actionIds?: readonly string[];
  agentIds?: readonly string[];
}

/** Caps: bound the response (a runaway draft) and the prompt (third-party tool names). */
const MAX_MISSING = 20;
const MAX_PROMPT_IDS = 60;
const MAX_ID_CHARS = 80;
const MAX_QUERY_CHARS = 40;
/** Tool names come from third-party MCP servers — only this alphabet reaches the prompt. */
const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

export function collectMissingCapabilities(graph: WorkflowGraph, known: KnownIds): MissingCapability[] {
  const out: MissingCapability[] = [];
  const actions = known.actionIds ? new Set(known.actionIds) : undefined;
  const agents = known.agentIds ? new Set(known.agentIds) : undefined;
  const steps = Array.isArray(graph.steps) ? graph.steps : [];
  for (const step of steps) {
    if (out.length >= MAX_MISSING) break;
    if (step.kind === 'action' && actions && step.actionId && !actions.has(step.actionId)) {
      out.push({ stepId: step.id, kind: 'action', ref: step.actionId, suggestedQuery: suggestedQuery(step.actionId) });
    } else if (step.kind === 'agent' && agents && step.agentId && !agents.has(step.agentId)) {
      out.push({ stepId: step.id, kind: 'agent', ref: step.agentId, suggestedQuery: suggestedQuery(step.agentId) });
    }
  }
  return out;
}

/** `pleo.list_missing_receipts` → `pleo`; `mcp:abc:tool` → `mcp` is useless, so strip the prefix first. */
export function suggestedQuery(ref: string): string {
  const bare = ref.startsWith('mcp:') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  const head = bare.split(/[.:]/, 1)[0] ?? bare;
  return head.trim().toLowerCase().slice(0, MAX_QUERY_CHARS);
}

/** One prompt block listing known ids (sanitized, capped, with a remainder note); empty when the set is unknown. */
export function renderKnownIdsBlock(title: string, ids: readonly string[] | undefined): string {
  if (!ids) return '';
  const safe = ids.filter((id) => SAFE_ID.test(id) && id.length <= MAX_ID_CHARS);
  if (safe.length === 0) return `${title}: (none registered)`;
  const shown = safe.slice(0, MAX_PROMPT_IDS);
  const more = safe.length > shown.length ? ` (+${String(safe.length - shown.length)} more not shown)` : '';
  return `${title}: ${shown.join(', ')}${more}`;
}
