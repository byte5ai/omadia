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

  // icon trait (canvas-protocol §12) — additive 1.1 vocabulary carried in the 1.0 whitelist.
  it('accepts the icon + iconState trait on a primitive', () => {
    expect(validateTree({ type: 'button', label: 'Play', icon: 'app:play', iconState: 'active' }).ok).toBe(true);
  });
  it('accepts a lib: icon ref', () => {
    expect(validateTree({ type: 'status', text: 'Synced', icon: 'lib:cloud-check' }).ok).toBe(true);
  });
  it('rejects an icon ref outside the app:/lib: namespaces', () => {
    expect(validateTree({ type: 'button', label: 'x', icon: 'https://evil/icon.svg' }).ok).toBe(false);
  });
  it('rejects the deferred gen: prefix until the §6 sanitised-SVG + consent review lands', () => {
    expect(validateTree({ type: 'button', label: 'x', icon: 'gen:sparkles' }).ok).toBe(false);
  });
  it('rejects iconState without an icon (dependentRequired)', () => {
    expect(validateTree({ type: 'button', label: 'x', iconState: 'active' }).ok).toBe(false);
  });
  it('rejects an unknown iconState value', () => {
    expect(validateTree({ type: 'button', label: 'x', icon: 'app:play', iconState: 'blinking' }).ok).toBe(false);
  });

  // chart spark variant — state-as-glyph.
  it('accepts the spark chart variant', () => {
    expect(
      validateTree({ type: 'chart', chartType: 'line', variant: 'spark', points: [{ pointKey: 'p1' }] }).ok,
    ).toBe(true);
  });
  it('rejects an unknown chart variant', () => {
    expect(
      validateTree({ type: 'chart', chartType: 'line', variant: 'gauge', points: [{ pointKey: 'p1' }] }).ok,
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
