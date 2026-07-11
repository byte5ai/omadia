import { describe, expect, it } from 'vitest';

import {
  NEAR_BUDGET_RATIO,
  OVER_BUDGET_RATIO,
  budgetRatio,
  budgetState,
  parseBudgetInput,
} from '../budget';

describe('budgetRatio', () => {
  it('returns cost/budget when a positive budget is set', () => {
    expect(budgetRatio(5, 10)).toBe(0.5);
    expect(budgetRatio(10, 10)).toBe(1);
    expect(budgetRatio(15, 10)).toBe(1.5);
  });

  it('returns null when the budget is unset or non-positive', () => {
    expect(budgetRatio(5, null)).toBeNull();
    expect(budgetRatio(5, undefined)).toBeNull();
    expect(budgetRatio(5, 0)).toBeNull();
    expect(budgetRatio(5, -1)).toBeNull();
  });

  it('returns null for a non-finite or negative cost', () => {
    expect(budgetRatio(Number.NaN, 10)).toBeNull();
    expect(budgetRatio(-1, 10)).toBeNull();
  });
});

describe('budgetState', () => {
  it('is none when no budget is set', () => {
    expect(budgetState(100, null)).toBe('none');
    expect(budgetState(100, undefined)).toBe('none');
  });

  it('is ok below the near threshold', () => {
    expect(budgetState(7.9, 10)).toBe('ok');
    expect(budgetState(0, 10)).toBe('ok');
  });

  it('is near at exactly 80% and up to just under 100%', () => {
    expect(budgetState(8, 10)).toBe('near');
    expect(budgetState(9.99, 10)).toBe('near');
    expect(budgetState(NEAR_BUDGET_RATIO * 10, 10)).toBe('near');
  });

  it('is over at exactly 100% and above', () => {
    expect(budgetState(10, 10)).toBe('over');
    expect(budgetState(12, 10)).toBe('over');
    expect(budgetState(OVER_BUDGET_RATIO * 10, 10)).toBe('over');
  });
});

describe('parseBudgetInput', () => {
  it('treats empty/whitespace as a valid clear (null)', () => {
    expect(parseBudgetInput('')).toEqual({ ok: true, value: null });
    expect(parseBudgetInput('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts strictly-positive numbers', () => {
    expect(parseBudgetInput('5')).toEqual({ ok: true, value: 5 });
    expect(parseBudgetInput(' 2.50 ')).toEqual({ ok: true, value: 2.5 });
    expect(parseBudgetInput('0.01')).toEqual({ ok: true, value: 0.01 });
  });

  it('rejects zero, negative, and non-numeric input', () => {
    expect(parseBudgetInput('0')).toEqual({ ok: false });
    expect(parseBudgetInput('-3')).toEqual({ ok: false });
    expect(parseBudgetInput('abc')).toEqual({ ok: false });
    expect(parseBudgetInput('1,5')).toEqual({ ok: false });
    expect(parseBudgetInput('1e3')).toEqual({ ok: false });
  });

  it('rejects fractional values when integer is required (token budgets)', () => {
    expect(parseBudgetInput('1000', { integer: true })).toEqual({ ok: true, value: 1000 });
    expect(parseBudgetInput('1000.5', { integer: true })).toEqual({ ok: false });
  });
});
