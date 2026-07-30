import { describe, expect, it } from 'vitest';

import { parseArtifactRecord } from '../prettyArtifact';

describe('parseArtifactRecord', () => {
  it('parses a plain JSON object', () => {
    expect(parseArtifactRecord('{"kind":"plan","approach":"do it"}')).toEqual({
      kind: 'plan',
      approach: 'do it',
    });
  });

  it('turns escaped \\n sequences into real newline characters', () => {
    const record = parseArtifactRecord('{"approach":"line one\\n\\nline two"}');
    expect(record?.['approach']).toBe('line one\n\nline two');
  });

  it('returns null for malformed JSON', () => {
    expect(parseArtifactRecord('not json')).toBeNull();
  });

  it('returns null for a top-level array', () => {
    expect(parseArtifactRecord('[1,2,3]')).toBeNull();
  });

  it('returns null for a top-level primitive', () => {
    expect(parseArtifactRecord('"just a string"')).toBeNull();
    expect(parseArtifactRecord('42')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(parseArtifactRecord('null')).toBeNull();
  });

  it('preserves nested arrays and objects as-is for the caller to handle', () => {
    const record = parseArtifactRecord('{"filesToTouch":["a.ts","b.ts"],"nested":{"x":1}}');
    expect(record?.['filesToTouch']).toEqual(['a.ts', 'b.ts']);
    expect(record?.['nested']).toEqual({ x: 1 });
  });
});
