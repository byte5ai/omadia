import { describe, it, expect } from 'vitest';
import { evaluatePredicate, resolvePath } from '../src/predicate.js';
import type { EvalScope, Predicate } from '../src/types.js';

const scope: EvalScope = {
  ctx: { base: 'main', amount: 1500, tags: ['rc', 'release'], nested: { ok: true } },
  stepResult: { approved: true, score: 42, name: 'Acme' },
};

describe('resolvePath', () => {
  it('resolves ctx and stepResult dot-paths', () => {
    expect(resolvePath(scope, 'ctx.base')).toBe('main');
    expect(resolvePath(scope, 'stepResult.approved')).toBe(true);
    expect(resolvePath(scope, 'ctx.nested.ok')).toBe(true);
  });
  it('indexes into arrays', () => {
    expect(resolvePath(scope, 'ctx.tags.0')).toBe('rc');
    expect(resolvePath(scope, 'ctx.tags.5')).toBeUndefined();
  });
  it('returns undefined for missing segments', () => {
    expect(resolvePath(scope, 'ctx.nope.deep')).toBeUndefined();
    expect(resolvePath(scope, 'stepResult.score.x')).toBeUndefined();
  });
});

describe('evaluatePredicate', () => {
  const cases: Array<[string, Predicate, boolean]> = [
    ['always', { op: 'always' }, true],
    ['never', { op: 'never' }, false],
    ['eq true', { op: 'eq', path: 'stepResult.approved', value: true }, true],
    ['eq mismatch', { op: 'eq', path: 'ctx.base', value: 'dev' }, false],
    ['ne', { op: 'ne', path: 'ctx.base', value: 'dev' }, true],
    ['exists', { op: 'exists', path: 'stepResult.name' }, true],
    ['exists missing', { op: 'exists', path: 'stepResult.missing' }, false],
    ['gt number', { op: 'gt', path: 'ctx.amount', value: 1000 }, true],
    ['lte number false', { op: 'lte', path: 'ctx.amount', value: 1000 }, false],
    ['gt type-mismatch is false', { op: 'gt', path: 'ctx.base', value: 1000 }, false],
    ['in', { op: 'in', path: 'ctx.base', value: ['main', 'master'] }, true],
    ['in miss', { op: 'in', path: 'ctx.base', value: ['dev'] }, false],
    ['matches', { op: 'matches', path: 'stepResult.name', value: '^Ac' }, true],
    ['matches non-string false', { op: 'matches', path: 'stepResult.score', value: '4' }, false],
    ['matches bad-regex false', { op: 'matches', path: 'stepResult.name', value: '(' }, false],
  ];
  for (const [name, pred, expected] of cases) {
    it(name, () => expect(evaluatePredicate(pred, scope)).toBe(expected));
  }

  it('composes and/or/not', () => {
    const p: Predicate = {
      op: 'and',
      args: [
        { op: 'eq', path: 'ctx.base', value: 'main' },
        { op: 'or', args: [{ op: 'eq', path: 'stepResult.approved', value: false }, { op: 'gt', path: 'stepResult.score', value: 10 }] },
        { op: 'not', arg: { op: 'exists', path: 'stepResult.missing' } },
      ],
    };
    expect(evaluatePredicate(p, scope)).toBe(true);
  });

  it('is deterministic across repeated evaluation', () => {
    const p: Predicate = { op: 'gt', path: 'ctx.amount', value: 1000 };
    expect(evaluatePredicate(p, scope)).toBe(evaluatePredicate(p, scope));
  });
});

// `valuePath` — compare against another dot-path instead of a literal. A budget
// the caller chooses cannot be a number frozen into the graph at authoring
// time: with only `value`, "stop after N turns" forces one N on every run of a
// pattern, which is how the first agent-discussion cut capped every exchange at
// seven whether or not it was still improving.
describe('evaluatePredicate — valuePath', () => {
  const budgets: EvalScope = {
    ctx: { turns: 3, maxTurns: 16, label: 'main', other: 'main' },
    stepResult: { count: 20 },
  };

  it('compares two ctx paths', () => {
    expect(evaluatePredicate({ op: 'lt', path: 'ctx.turns', valuePath: 'ctx.maxTurns' }, budgets)).toBe(true);
    expect(evaluatePredicate({ op: 'gt', path: 'ctx.turns', valuePath: 'ctx.maxTurns' }, budgets)).toBe(false);
  });

  it('compares across scopes', () => {
    expect(evaluatePredicate({ op: 'gt', path: 'stepResult.count', valuePath: 'ctx.turns' }, budgets)).toBe(true);
  });

  it('supports equality against a path', () => {
    expect(evaluatePredicate({ op: 'eq', path: 'ctx.label', valuePath: 'ctx.other' }, budgets)).toBe(true);
    expect(evaluatePredicate({ op: 'ne', path: 'ctx.label', valuePath: 'ctx.other' }, budgets)).toBe(false);
  });

  it('STOPS a loop when the budget is missing — never runs on a value that does not exist', () => {
    // The failure mode of a guard is a runaway loop, so an absent ceiling must
    // not read as an infinite one. False for every op, `ne` included, which
    // would otherwise invert into "keep going".
    expect(evaluatePredicate({ op: 'lt', path: 'ctx.turns', valuePath: 'ctx.nope' }, budgets)).toBe(false);
    expect(evaluatePredicate({ op: 'ne', path: 'ctx.turns', valuePath: 'ctx.nope' }, budgets)).toBe(false);
    expect(evaluatePredicate({ op: 'eq', path: 'ctx.turns', valuePath: 'ctx.nope' }, budgets)).toBe(false);
  });

  it('prefers valuePath over a literal when a graph declares both', () => {
    expect(evaluatePredicate({ op: 'lt', path: 'ctx.turns', value: 1, valuePath: 'ctx.maxTurns' }, budgets)).toBe(true);
  });

  it('leaves literal comparisons untouched', () => {
    expect(evaluatePredicate({ op: 'lt', path: 'ctx.turns', value: 16 }, budgets)).toBe(true);
    expect(evaluatePredicate({ op: 'ne', path: 'ctx.label', value: 'other' }, budgets)).toBe(true);
  });
});
