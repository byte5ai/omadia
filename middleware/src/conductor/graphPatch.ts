// Conductor draft-graph patch algebra (US7 conversational builder).
//
// The conversational builder agent authors a Conductor workflow by emitting a small,
// closed set of structured patches over a draft `WorkflowGraph`. These seven ops are the
// complete basis for mutating a graph: anything else is a composition of them. Application
// is a pure function — no I/O, no validation — so it is trivially unit-testable. The caller
// (the builder agent / route) runs `@omadia/conductor-core` `validate()` on the *result*;
// this module only applies the edit and reports per-patch structural problems (e.g. an
// update to a step that does not exist), never silently dropping a malformed op.
//
// Deliberately kept kernel-side rather than in the pure `@omadia/conductor-core` engine:
// patches are an LLM-authoring concern, not an execution concern, so the engine's surface
// stays minimal (validate + nextStep).

import type { Step, Transition, Trigger, WorkflowGraph } from '@omadia/conductor-core';

export type GraphPatch =
  | { op: 'add_step'; step: Step }
  | { op: 'update_step'; id: string; patch: Partial<Step> }
  | { op: 'remove_step'; id: string }
  | { op: 'add_transition'; transition: Transition }
  | { op: 'remove_transition'; id: string }
  | { op: 'set_trigger'; trigger: Trigger }
  | { op: 'set_entry'; stepId: string };

export interface ApplyResult {
  graph: WorkflowGraph;
  /** number of patches that applied cleanly. */
  applied: number;
  /** human-readable problems for ops that referenced missing nodes / were malformed. */
  errors: string[];
}

/** An empty draft — the starting point for a brand-new conversational build. */
export function emptyGraph(): WorkflowGraph {
  return { entryStepId: '', steps: [], transitions: [], triggers: [] };
}

function clone(graph: WorkflowGraph): WorkflowGraph {
  // structuredClone is available on Node 18+ and keeps the apply pure (no aliasing into the
  // caller's draft). Steps/transitions are plain JSON, so this is a faithful deep copy.
  return structuredClone(graph);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Apply an ordered list of patches to a draft graph, purely. Returns a NEW graph (the input is
 * never mutated), the count that applied, and a list of structural errors for ops that could
 * not apply (unknown ids, duplicate ids, malformed shapes). Ops that error are skipped; the
 * rest still apply, so a single bad patch never discards a whole turn's work.
 */
export function applyGraphPatches(base: WorkflowGraph, patches: readonly GraphPatch[]): ApplyResult {
  const graph = clone(base);
  // Normalize a possibly-malformed input graph (a truthy `{}` body reaches here without being
  // replaced by emptyGraph()) so the ops below never throw on a non-array — a bad body becomes a
  // clean validation failure downstream, not a 500.
  if (!Array.isArray(graph.steps)) graph.steps = [];
  if (!Array.isArray(graph.transitions)) graph.transitions = [];
  if (!Array.isArray(graph.triggers)) graph.triggers = [];
  const errors: string[] = [];
  let applied = 0;

  for (const patch of patches) {
    // A single patch can never throw out of the loop — the contract is "skip the bad op, apply the
    // rest". Any unexpected error (e.g. a malformed nested shape) is recorded as an apply error so
    // the turn can self-correct instead of 500-ing.
    try {
    if (!isObject(patch) || typeof patch.op !== 'string') {
      errors.push(`malformed patch: ${JSON.stringify(patch)}`);
      continue;
    }
    switch (patch.op) {
      case 'add_step': {
        const step = patch.step;
        if (!isObject(step) || typeof step.id !== 'string' || !step.id) {
          errors.push('add_step: step.id is required');
          break;
        }
        if (graph.steps.some((s) => s.id === step.id)) {
          errors.push(`add_step: step '${step.id}' already exists`);
          break;
        }
        graph.steps.push(step);
        if (!graph.entryStepId) graph.entryStepId = step.id; // first step becomes entry by default
        applied += 1;
        break;
      }
      case 'update_step': {
        const idx = graph.steps.findIndex((s) => s.id === patch.id);
        const existing = idx === -1 ? undefined : graph.steps[idx];
        if (!existing) {
          errors.push(`update_step: step '${patch.id}' not found`);
          break;
        }
        // `patch` is LLM-authored — tolerate a missing/non-object `patch.patch` instead of throwing.
        const fields = isObject(patch.patch) ? (patch.patch as Partial<Step>) : {};
        // id and kind are NEVER changed by an update (a kind change would orphan the prior kind's
        // fields) — use remove_step + add_step to change a step's kind.
        const next: Step = { ...existing, ...fields, id: existing.id, kind: existing.kind };
        graph.steps[idx] = next;
        applied += 1;
        break;
      }
      case 'remove_step': {
        const before = graph.steps.length;
        graph.steps = graph.steps.filter((s) => s.id !== patch.id);
        if (graph.steps.length === before) {
          errors.push(`remove_step: step '${patch.id}' not found`);
          break;
        }
        // Drop transitions that dangle off the removed step so the result stays coherent.
        graph.transitions = graph.transitions.filter((tr) => tr.source !== patch.id && tr.target !== patch.id);
        // Clear any surviving step's fallbackTransitionId that pointed at a now-dropped transition,
        // so the result doesn't validate-fail on `fallback_unknown_transition`.
        const liveTransitionIds = new Set(graph.transitions.map((tr) => tr.id));
        graph.steps = graph.steps.map((s) =>
          s.fallbackTransitionId && !liveTransitionIds.has(s.fallbackTransitionId)
            ? { ...s, fallbackTransitionId: undefined }
            : s,
        );
        // Re-home the entry pointer if the removed step was the entry.
        if (graph.entryStepId === patch.id) graph.entryStepId = graph.steps[0]?.id ?? '';
        applied += 1;
        break;
      }
      case 'add_transition': {
        const tr = patch.transition;
        if (!isObject(tr) || typeof tr.id !== 'string' || !tr.id) {
          errors.push('add_transition: transition.id is required');
          break;
        }
        if (graph.transitions.some((t) => t.id === tr.id)) {
          errors.push(`add_transition: transition '${tr.id}' already exists`);
          break;
        }
        graph.transitions.push(tr);
        applied += 1;
        break;
      }
      case 'remove_transition': {
        const before = graph.transitions.length;
        graph.transitions = graph.transitions.filter((t) => t.id !== patch.id);
        if (graph.transitions.length === before) {
          errors.push(`remove_transition: transition '${patch.id}' not found`);
          break;
        }
        applied += 1;
        break;
      }
      case 'set_trigger': {
        const tr = patch.trigger;
        if (!isObject(tr) || typeof tr.id !== 'string' || typeof tr.kind !== 'string') {
          errors.push('set_trigger: trigger.id and trigger.kind are required');
          break;
        }
        // The Designer models a single trigger; keep parity by replacing rather than appending.
        graph.triggers = [tr];
        applied += 1;
        break;
      }
      case 'set_entry': {
        if (typeof patch.stepId !== 'string' || !patch.stepId) {
          errors.push('set_entry: stepId is required');
          break;
        }
        graph.entryStepId = patch.stepId; // validate() flags an unknown entry — not enforced here
        applied += 1;
        break;
      }
      default: {
        errors.push(`unknown patch op: ${String((patch as { op: unknown }).op)}`);
      }
    }
    } catch (err) {
      const op = isObject(patch) ? String(patch.op) : 'unknown';
      errors.push(`patch '${op}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { graph, applied, errors };
}
