// Semantic workflow-graph validation (FR-003). Pure; uses ajv only for the shape gate.

import type {
  KnownRefs,
  Step,
  Transition,
  ValidationError,
  ValidationResult,
  WorkflowGraph,
} from './types.js';
import { validateGraphShape } from './schema.js';

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Steps reachable from `entry` by following transitions whose endpoints both exist. */
function computeReachable(entry: string, transitions: Transition[], stepIds: Set<string>): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const t of transitions) {
    if (!stepIds.has(t.source) || !stepIds.has(t.target)) continue;
    (adjacency.get(t.source) ?? adjacency.set(t.source, []).get(t.source)!).push(t.target);
  }
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Find a cycle reachable through transitions that carry NO guard (a cycle with no progress
 *  guard). Returns the step ids on the cycle, or null. */
function findUnguardedCycle(transitions: Transition[], stepIds: Set<string>): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const t of transitions) {
    if (t.guard !== undefined) continue; // only unguarded edges
    if (!stepIds.has(t.source) || !stepIds.has(t.target)) continue;
    (adjacency.get(t.source) ?? adjacency.set(t.source, []).get(t.source)!).push(t.target);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // back-edge → cycle from `next` down to `node`
        const start = stack.indexOf(next);
        return stack.slice(start).concat(next);
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return null;
  }

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Validate a workflow graph: structural shape, unique ids, resolvable transition endpoints
 * and fallbacks, reachability, unguarded cycles, deadline-without-fallback, per-kind config,
 * and (when `knownRefs` is supplied) that referenced agents/actions/roles/events resolve.
 */
export function validate(graph: WorkflowGraph, knownRefs?: KnownRefs): ValidationResult {
  // 0. shape gate — if the raw shape is wrong, deeper checks would be noise.
  const shape = validateGraphShape(graph);
  if (!shape.ok) {
    return {
      ok: false,
      errors: [{ code: 'shape', message: `graph shape invalid: ${shape.errors.join('; ')}`, nodeIds: [] }],
    };
  }

  const errors: ValidationError[] = [];
  const steps = graph.steps;
  const transitions = graph.transitions;

  // 1. unique ids
  const stepById = new Map<string, Step>();
  const dupSteps: string[] = [];
  for (const s of steps) {
    if (stepById.has(s.id)) dupSteps.push(s.id);
    else stepById.set(s.id, s);
  }
  if (dupSteps.length) {
    errors.push({ code: 'duplicate_step_id', message: `duplicate step id(s): ${unique(dupSteps).join(', ')}`, nodeIds: unique(dupSteps) });
  }
  const txById = new Map<string, Transition>();
  const dupTx: string[] = [];
  for (const t of transitions) {
    if (txById.has(t.id)) dupTx.push(t.id);
    else txById.set(t.id, t);
  }
  if (dupTx.length) {
    errors.push({ code: 'duplicate_transition_id', message: `duplicate transition id(s): ${unique(dupTx).join(', ')}`, nodeIds: unique(dupTx) });
  }

  const stepIds = new Set(stepById.keys());

  // 2. entry step exists
  if (!stepIds.has(graph.entryStepId)) {
    errors.push({ code: 'unknown_entry_step', message: `entryStepId '${graph.entryStepId}' is not a declared step`, nodeIds: [graph.entryStepId] });
  }

  // 3. transition endpoints resolve
  for (const t of transitions) {
    if (!stepIds.has(t.source)) {
      errors.push({ code: 'transition_unknown_source', message: `transition '${t.id}' source '${t.source}' is not a step`, nodeIds: [t.id] });
    }
    if (!stepIds.has(t.target)) {
      errors.push({ code: 'transition_unknown_target', message: `transition '${t.id}' target '${t.target}' is not a step`, nodeIds: [t.id] });
    }
  }

  // 4. per-step: kind config, fallback resolution, deadline-without-fallback, known refs
  for (const s of steps) {
    if (s.kind === 'agent' && !s.agentId) {
      errors.push({ code: 'agent_step_missing_agent', message: `agent step '${s.id}' has no agentId`, nodeIds: [s.id] });
    }
    if (s.kind === 'action' && !s.actionId) {
      errors.push({ code: 'action_step_missing_action', message: `action step '${s.id}' has no actionId`, nodeIds: [s.id] });
    }
    if (s.kind === 'human' && !s.human) {
      errors.push({ code: 'human_step_missing_config', message: `human step '${s.id}' has no human config`, nodeIds: [s.id] });
    }

    if (s.fallbackTransitionId !== undefined) {
      const fb = txById.get(s.fallbackTransitionId);
      if (!fb) {
        errors.push({ code: 'fallback_unknown_transition', message: `step '${s.id}' fallbackTransitionId '${s.fallbackTransitionId}' is not a transition`, nodeIds: [s.id] });
      } else if (fb.source !== s.id) {
        errors.push({ code: 'fallback_wrong_source', message: `step '${s.id}' fallback transition '${fb.id}' does not originate from this step`, nodeIds: [s.id, fb.id] });
      }
    }

    if (s.kind === 'human' && s.human && s.human.deadline != null && s.fallbackTransitionId === undefined) {
      errors.push({ code: 'deadline_without_fallback', message: `human step '${s.id}' has a deadline but no fallbackTransitionId`, nodeIds: [s.id] });
    }

    if (knownRefs?.agentIds && s.kind === 'agent' && s.agentId && !knownRefs.agentIds.includes(s.agentId)) {
      errors.push({ code: 'unknown_agent_ref', message: `step '${s.id}' references unknown agent '${s.agentId}'`, nodeIds: [s.id] });
    }
    if (knownRefs?.actionIds && s.kind === 'action' && s.actionId && !knownRefs.actionIds.includes(s.actionId)) {
      errors.push({ code: 'unknown_action_ref', message: `step '${s.id}' references unknown action '${s.actionId}'`, nodeIds: [s.id] });
    }
    if (knownRefs?.roleKeys && s.kind === 'human' && s.human?.principal.kind === 'role' && !knownRefs.roleKeys.includes(s.human.principal.ref)) {
      errors.push({ code: 'unknown_role_ref', message: `step '${s.id}' references unknown role '${s.human.principal.ref}'`, nodeIds: [s.id] });
    }
  }

  // 5. triggers: event triggers need an eventId (and a known one if refs supplied)
  for (const tr of graph.triggers ?? []) {
    if (tr.kind === 'event') {
      if (!tr.eventId) {
        errors.push({ code: 'unknown_event_ref', message: `event trigger '${tr.id}' has no eventId`, nodeIds: [tr.id] });
      } else if (knownRefs?.eventIds && !knownRefs.eventIds.includes(tr.eventId)) {
        errors.push({ code: 'unknown_event_ref', message: `event trigger '${tr.id}' references unknown event '${tr.eventId}'`, nodeIds: [tr.id] });
      }
    }
  }

  // 6. reachability (only meaningful when entry resolves)
  if (stepIds.has(graph.entryStepId)) {
    const reachable = computeReachable(graph.entryStepId, transitions, stepIds);
    for (const s of steps) {
      if (!reachable.has(s.id)) {
        errors.push({ code: 'unreachable_step', message: `step '${s.id}' is unreachable from entry step '${graph.entryStepId}'`, nodeIds: [s.id] });
      }
    }
  }

  // 7. unguarded cycle
  const cycle = findUnguardedCycle(transitions, stepIds);
  if (cycle) {
    errors.push({ code: 'unguarded_cycle', message: `unguarded cycle: ${cycle.join(' -> ')}`, nodeIds: unique(cycle) });
  }

  return { ok: errors.length === 0, errors };
}
