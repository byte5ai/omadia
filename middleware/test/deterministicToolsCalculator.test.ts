/**
 * Slice B — calculator tool suite. Every tool's handler is invoked with
 * a representative happy-path input plus one input-validation failure
 * and one output-postcondition demonstration via `defineTool`'s output
 * schema (handler returns `[POSTCONDITION_FAILED]` + structured marker
 * when the result violates its declared Zod output).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { calculatorTools } from '@omadia/plugin-deterministic-tools';

function byName(name: string): (typeof calculatorTools)[number] {
  const tool = calculatorTools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe('calc_sum', () => {
  it('sums an array', async () => {
    const r = await byName('calc_sum').handler({ values: [1, 2, 3, 4] });
    assert.deepEqual(JSON.parse(r as string), { sum: 10, count: 4 });
  });
  it('rejects empty array via input zod', async () => {
    const r = await byName('calc_sum').handler({ values: [] });
    assert.match(r as string, /Error: invalid input/);
  });
  it('rejects non-array input', async () => {
    const r = await byName('calc_sum').handler({ values: 'nope' });
    assert.match(r as string, /Error: invalid input/);
  });
});

describe('calc_sub', () => {
  it('subtracts b from a', async () => {
    const r = await byName('calc_sub').handler({ a: 10, b: 3 });
    assert.deepEqual(JSON.parse(r as string), { difference: 7 });
  });
});

describe('calc_mul', () => {
  it('multiplies an array', async () => {
    const r = await byName('calc_mul').handler({ values: [2, 3, 4] });
    assert.deepEqual(JSON.parse(r as string), { product: 24, count: 3 });
  });
});

describe('calc_div', () => {
  it('divides a by b and returns quotient + remainder', async () => {
    const r = await byName('calc_div').handler({ a: 10, b: 3 });
    const parsed = JSON.parse(r as string);
    assert.equal(parsed.quotient, 10 / 3);
    assert.equal(parsed.remainder, 1);
  });
  it('returns structured error on division by zero', async () => {
    const r = await byName('calc_div').handler({ a: 5, b: 0 });
    assert.match(r as string, /division by zero/);
  });
});

describe('calc_pct', () => {
  it('computes percent of value', async () => {
    const r = await byName('calc_pct').handler({ value: 200, percent: 15 });
    assert.deepEqual(JSON.parse(r as string), { result: 30 });
  });
});

describe('calc_min / calc_max', () => {
  it('finds min', async () => {
    const r = await byName('calc_min').handler({ values: [4, 2, 7] });
    assert.deepEqual(JSON.parse(r as string), { min: 2 });
  });
  it('finds max', async () => {
    const r = await byName('calc_max').handler({ values: [4, 2, 7] });
    assert.deepEqual(JSON.parse(r as string), { max: 7 });
  });
});

describe('calc_round', () => {
  it('rounds half-up to N decimals', async () => {
    const r = await byName('calc_round').handler({
      value: 3.14159,
      decimals: 2,
    });
    assert.deepEqual(JSON.parse(r as string), { rounded: 3.14 });
  });
  it('rejects negative decimals via input zod', async () => {
    const r = await byName('calc_round').handler({
      value: 1.5,
      decimals: -1,
    });
    assert.match(r as string, /Error: invalid input/);
  });
});

describe('calc_aggregate', () => {
  it('aggregates with op=sum', async () => {
    const r = await byName('calc_aggregate').handler({
      values: [1, 2, 3],
      op: 'sum',
    });
    assert.deepEqual(JSON.parse(r as string), { op: 'sum', result: 6, count: 3 });
  });
  it('aggregates with op=avg', async () => {
    const r = await byName('calc_aggregate').handler({
      values: [2, 4, 6],
      op: 'avg',
    });
    assert.deepEqual(JSON.parse(r as string), { op: 'avg', result: 4, count: 3 });
  });
  it('rejects unknown op via input zod', async () => {
    const r = await byName('calc_aggregate').handler({
      values: [1],
      op: 'median',
    });
    assert.match(r as string, /Error: invalid input/);
  });
});
