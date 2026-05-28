/**
 * Slice B — logic tool suite. Each tool gets one happy-path test and one
 * adversarial path (input mismatch, edge case). The Postcondition layer
 * is exercised end-to-end by the calculator + verifier-pipeline tests
 * already in the suite; here we focus on operator correctness.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { logicTools } from '@omadia/plugin-deterministic-tools';

function byName(name: string): (typeof logicTools)[number] {
  const tool = logicTools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe('set_intersection', () => {
  it('returns intersection of two arrays', async () => {
    const r = await byName('set_intersection').handler({
      a: ['x', 'y', 'z'],
      b: ['y', 'z', 'a'],
    });
    const parsed = JSON.parse(r as string);
    assert.deepEqual(parsed.intersection.sort(), ['y', 'z']);
    assert.equal(parsed.count, 2);
  });
  it('handles disjoint arrays (empty intersection)', async () => {
    const r = await byName('set_intersection').handler({
      a: [1, 2],
      b: [3, 4],
    });
    const parsed = JSON.parse(r as string);
    assert.deepEqual(parsed.intersection, []);
    assert.equal(parsed.count, 0);
  });
});

describe('set_difference', () => {
  it('returns a \\ b', async () => {
    const r = await byName('set_difference').handler({
      a: [1, 2, 3, 4],
      b: [2, 4],
    });
    const parsed = JSON.parse(r as string);
    assert.deepEqual(parsed.difference.sort(), [1, 3]);
    assert.equal(parsed.count, 2);
  });
});

describe('set_subset', () => {
  it('reports is_subset=true when all elements of a are in b', async () => {
    const r = await byName('set_subset').handler({
      a: [1, 2],
      b: [1, 2, 3, 4],
    });
    const parsed = JSON.parse(r as string);
    assert.equal(parsed.is_subset, true);
    assert.deepEqual(parsed.missing, []);
  });
  it('lists missing elements when not a subset', async () => {
    const r = await byName('set_subset').handler({
      a: [1, 5],
      b: [1, 2, 3],
    });
    const parsed = JSON.parse(r as string);
    assert.equal(parsed.is_subset, false);
    assert.deepEqual(parsed.missing, [5]);
  });
});

describe('range_check_number', () => {
  it('reports in_range=true when value is within [min, max]', async () => {
    const r = await byName('range_check_number').handler({
      value: 5,
      min: 1,
      max: 10,
    });
    assert.deepEqual(JSON.parse(r as string), {
      in_range: true,
      reason: 'within range',
    });
  });
  it('reports in_range=false with reason when out of range', async () => {
    const r = await byName('range_check_number').handler({
      value: 15,
      min: 1,
      max: 10,
    });
    const parsed = JSON.parse(r as string);
    assert.equal(parsed.in_range, false);
    assert.match(parsed.reason, /> max=10/);
  });
});

describe('range_check_date', () => {
  it('accepts ISO date strings within the range', async () => {
    const r = await byName('range_check_date').handler({
      value: '2026-05-15',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    assert.deepEqual(JSON.parse(r as string), {
      in_range: true,
      reason: 'within range',
    });
  });
  it('rejects non-ISO strings via input zod', async () => {
    const r = await byName('range_check_date').handler({
      value: 'not-a-date',
    });
    assert.match(r as string, /Error: invalid input/);
  });
});

describe('predicate_eval', () => {
  it('returns matches=true when all conditions pass', async () => {
    const r = await byName('predicate_eval').handler({
      record: { stock: 10, on_sale: true },
      conditions: [
        { field: 'stock', op: 'gt', value: 0 },
        { field: 'on_sale', op: 'eq', value: true },
      ],
    });
    assert.deepEqual(JSON.parse(r as string), {
      matches: true,
      failed: [],
    });
  });
  it('lists every failed condition with actual + expected', async () => {
    const r = await byName('predicate_eval').handler({
      record: { stock: 0 },
      conditions: [
        { field: 'stock', op: 'gt', value: 0 },
        { field: 'category', op: 'in', value: ['toys', 'food'] },
      ],
    });
    const parsed = JSON.parse(r as string);
    assert.equal(parsed.matches, false);
    assert.equal(parsed.failed.length, 2);
  });
});

describe('lookup_table', () => {
  it('returns found+value when key is present', async () => {
    const r = await byName('lookup_table').handler({
      table: { de: 'Deutsch', en: 'English' },
      key: 'de',
    });
    assert.deepEqual(JSON.parse(r as string), {
      found: true,
      value: 'Deutsch',
    });
  });
  it('returns found=false when key is missing', async () => {
    const r = await byName('lookup_table').handler({
      table: { de: 'Deutsch' },
      key: 'jp',
    });
    assert.deepEqual(JSON.parse(r as string), {
      found: false,
      value: null,
    });
  });
});
