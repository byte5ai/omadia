import { describe, expect, it } from 'vitest';

import { computeLineDiff } from '../lineDiff';

describe('computeLineDiff', () => {
  it('returns all-context for identical text', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('marks a single changed line as remove+add, keeping context around it', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nx\nc');
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('handles a pure insertion', () => {
    const diff = computeLineDiff('a\nc', 'a\nb\nc');
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('handles a pure deletion', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nc');
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('handles an empty old string (pure addition)', () => {
    const diff = computeLineDiff('', 'a\nb');
    expect(diff).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('handles an empty new string (pure removal)', () => {
    const diff = computeLineDiff('a\nb', '');
    expect(diff).toEqual([
      { type: 'remove', text: 'a' },
      { type: 'remove', text: 'b' },
    ]);
  });

  it('handles two empty strings', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });

  it('falls back to a remove-all/add-all block for pathologically large inputs', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join('\n');
    const bigger = Array.from({ length: 3000 }, (_, i) => `other-${i}`).join('\n');
    const diff = computeLineDiff(big, bigger);
    expect(diff.every((l, idx) => (idx < 3000 ? l.type === 'remove' : l.type === 'add'))).toBe(true);
    expect(diff).toHaveLength(6000);
  });
});
