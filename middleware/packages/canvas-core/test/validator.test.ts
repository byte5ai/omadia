import { describe, expect, it } from 'vitest';
import { validateSurfaceEvent, validateTree } from '../src/validator.js';

const VALID_TREE = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [
    { type: 'heading', id: 'h', content: 'Hello', level: 2 },
    {
      type: 'table',
      id: 't',
      columns: [{ fieldKey: 'owner', label: 'Owner' }],
      rows: [{ rowKey: 'a', cells: { owner: 'Anna' } }],
    },
  ],
};

describe('validateTree (whitelist parser)', () => {
  it('accepts a conforming tree', () => {
    expect(validateTree(VALID_TREE)).toMatchObject({ ok: true });
  });
  it('rejects an unknown primitive type', () => {
    expect(validateTree({ type: 'iframe', src: 'https://evil' }).ok).toBe(false);
  });
  it('rejects an unknown prop on a known primitive (unevaluatedProperties)', () => {
    expect(validateTree({ type: 'divider', onClick: 'javascript:alert(1)' }).ok).toBe(false);
  });
  it('rejects a table row without rowKey', () => {
    expect(
      validateTree({
        type: 'table',
        columns: [{ fieldKey: 'x', label: 'X' }],
        rows: [{ cells: { x: 1 } }],
      }).ok,
    ).toBe(false);
  });
});

describe('validateSurfaceEvent', () => {
  it('accepts a surface_snapshot', () => {
    expect(
      validateSurfaceEvent({
        type: 'surface_snapshot',
        canvasSessionId: 'c',
        surfaceSeq: 0,
        producesRevision: '0',
        tree: VALID_TREE,
        protocolVersion: '1.0',
        opsCatalogVersion: '1.0',
      }),
    ).toMatchObject({ ok: true });
  });
  it('rejects a snapshot missing the envelope', () => {
    expect(
      validateSurfaceEvent({ type: 'surface_snapshot', producesRevision: '0', tree: VALID_TREE }).ok,
    ).toBe(false);
  });
  it('rejects an unknown event type', () => {
    expect(validateSurfaceEvent({ type: 'surface_eval', canvasSessionId: 'c', surfaceSeq: 1 }).ok).toBe(false);
  });
});
