import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validate } from '../src/validate.js';
import { nextStep } from '../src/engine.js';
import { conductorGraphSchema } from '../src/schema.js';
import type { Decision, JsonObject, JsonValue, WorkflowGraph } from '../src/types.js';

function loadJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
}

describe('fixtures — validation', () => {
  it('valid-release-signoff passes validation', () => {
    const g = loadJson('../fixtures/valid-release-signoff.json') as WorkflowGraph;
    expect(validate(g)).toEqual({ ok: true, errors: [] });
  });

  const invalids: Array<[string, string]> = [
    ['../fixtures/invalid-unreachable.json', 'unreachable_step'],
    ['../fixtures/invalid-unguarded-cycle.json', 'unguarded_cycle'],
    ['../fixtures/invalid-deadline-no-fallback.json', 'deadline_without_fallback'],
  ];
  for (const [file, expectedCode] of invalids) {
    it(`${file} fails with ${expectedCode}`, () => {
      const g = loadJson(file) as WorkflowGraph;
      const r = validate(g);
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.code)).toContain(expectedCode);
    });
  }
});

describe('fixtures — deterministic walk through valid-release-signoff', () => {
  const g = loadJson('../fixtures/valid-release-signoff.json') as WorkflowGraph;

  /** Drive the engine through a graph from `entryStepId`, feeding a per-step result. */
  function walk(stepResults: Record<string, JsonValue>, ctx: JsonObject): Decision[] {
    const path: Decision[] = [];
    let stepId: string | undefined = g.entryStepId;
    const guard = new Set<string>();
    while (stepId) {
      if (guard.has(stepId)) throw new Error(`loop at ${stepId}`);
      guard.add(stepId);
      const d = nextStep(g, stepId, stepResults[stepId] ?? {}, ctx);
      path.push(d);
      stepId = d.kind === 'advance' ? d.targetStepId : undefined;
    }
    return path;
  }

  it('approval path: s1 -t1-> s2 -t_approve-> s3 -> complete', () => {
    const path = walk({ s1: { notes: 'cut' }, s2: { approved: true } }, { base: 'main', tag: 'v1' });
    expect(path.map((d) => (d.kind === 'advance' ? d.transitionId : d.kind))).toEqual(['t1', 't_approve', 'complete']);
  });

  it('deadline path: unmet approval falls through to s_autoreject', () => {
    const path = walk({ s1: { notes: 'cut' }, s2: { approved: false } }, { base: 'main' });
    expect(path.map((d) => (d.kind === 'advance' ? d.transitionId : d.kind))).toEqual(['t1', 't_deadline', 'complete']);
  });

  it('agent-failure path: s1 postcondition unmet → t_fail', () => {
    const path = walk({ s1: {}, s_end_fail: {} }, { base: 'main' });
    expect(path[0]).toMatchObject({ kind: 'advance', transitionId: 't_fail', reason: 'postcondition_unmet_fallback' });
  });

  it('is deterministic across repeated walks', () => {
    const a = walk({ s1: { notes: 'cut' }, s2: { approved: true } }, { base: 'main' });
    const b = walk({ s1: { notes: 'cut' }, s2: { approved: true } }, { base: 'main' });
    expect(a).toEqual(b);
  });
});

describe('schema parity', () => {
  it('published schema/conductor-graph.schema.json equals the exported conductorGraphSchema', () => {
    const published = loadJson('../schema/conductor-graph.schema.json');
    expect(published).toEqual(conductorGraphSchema);
  });
});
