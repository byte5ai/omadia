import { describe, expect, it } from 'vitest';
import { applyTreePatches } from '../src/treePatch.js';

const tree = () => ({
  type: 'container',
  children: [
    { type: 'table', rows: [{ rowKey: 'a', cells: { owner: 'Anna' } }] },
    { type: 'status', text: 'loading' },
  ],
});

describe('applyTreePatches', () => {
  it('appends to an array with "-"', () => {
    const out = applyTreePatches(tree(), [
      { op: 'add', path: '/children/0/rows/-', value: { rowKey: 'b', cells: { owner: 'Bernd' } } },
    ]) as ReturnType<typeof tree>;
    expect(out.children[0]).toMatchObject({ rows: [{ rowKey: 'a' }, { rowKey: 'b' }] });
  });

  it('replaces a nested value and adds an object key', () => {
    const out = applyTreePatches(tree(), [
      { op: 'replace', path: '/children/1/text', value: 'done' },
      { op: 'add', path: '/children/0/rows/0/cells/vacation', value: 'Out' },
    ]) as ReturnType<typeof tree>;
    expect(out.children[1]).toMatchObject({ text: 'done' });
    expect(
      (out.children[0] as { rows: Array<{ cells: Record<string, unknown> }> }).rows[0]?.cells['vacation'],
    ).toBe('Out');
  });

  it('removes array entries and object keys', () => {
    const out = applyTreePatches(tree(), [{ op: 'remove', path: '/children/1' }]) as ReturnType<typeof tree>;
    expect(out.children).toHaveLength(1);
  });

  it('does not mutate the input tree', () => {
    const input = tree();
    applyTreePatches(input, [{ op: 'replace', path: '/children/1/text', value: 'x' }]);
    expect(input.children[1]).toMatchObject({ text: 'loading' });
  });

  it('throws on replace of a missing path, malformed ops, and unescapes ~0/~1', () => {
    expect(() => applyTreePatches(tree(), [{ op: 'replace', path: '/nope/x', value: 1 }])).toThrow();
    expect(() => applyTreePatches(tree(), [{ op: 'move', path: '/a' } as never])).toThrow();
    const out = applyTreePatches({ 'a/b': 1, 'c~d': 2 }, [
      { op: 'replace', path: '/a~1b', value: 9 },
    ]) as Record<string, number>;
    expect(out['a/b']).toBe(9);
  });
});
