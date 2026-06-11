import { describe, expect, it } from 'vitest';
import { applyServerMessage, initialCanvasState } from '../src/canvasStore.js';
import type { ServerMessage } from '../src/protocol.js';

const TREE = { type: 'container', id: 'root', children: [{ type: 'status', id: 's', text: 'hi' }] };
const snapshot = (seq: number, rev: string): ServerMessage => ({
  type: 'surface_snapshot',
  canvasSessionId: 'c',
  surfaceSeq: seq,
  producesRevision: rev,
  tree: TREE,
  protocolVersion: '1.0',
  opsCatalogVersion: '1.0',
});
const patch = (seq: number, base: string, prod: string, patches: unknown[]): ServerMessage => ({
  type: 'surface_patch',
  canvasSessionId: 'c',
  surfaceSeq: seq,
  basedOnRevision: base,
  producesRevision: prod,
  patches,
});

describe('applyServerMessage', () => {
  it('applies snapshot then a matching patch', () => {
    let r = applyServerMessage(initialCanvasState, snapshot(0, '0'));
    expect(r.resync).toBe(false);
    expect(r.state.revision).toBe('0');
    r = applyServerMessage(
      r.state,
      patch(1, '0', '1', [{ op: 'replace', path: '/children/0/text', value: 'done' }]),
    );
    expect(r.resync).toBe(false);
    expect(r.state.revision).toBe('1');
    expect(JSON.stringify(r.state.tree)).toContain('"done"');
  });

  it('requests resync on basedOnRevision mismatch (equality-only)', () => {
    const s = applyServerMessage(initialCanvasState, snapshot(0, '0')).state;
    const r = applyServerMessage(s, patch(1, '7', '8', []));
    expect(r.resync).toBe(true);
    expect(r.state.revision).toBe('0'); // unchanged
  });

  it('requests resync on a surfaceSeq gap', () => {
    const s = applyServerMessage(initialCanvasState, snapshot(0, '0')).state;
    const r = applyServerMessage(s, patch(5, '0', '1', []));
    expect(r.resync).toBe(true);
  });

  it('accepts a second-turn snapshot whose seq resets to 0 (no false gap)', () => {
    let r = applyServerMessage(initialCanvasState, snapshot(0, '0'));
    r = applyServerMessage(r.state, patch(1, '0', '1', []));
    expect(r.state.lastSurfaceSeq).toBe(1);
    // next turn: server restarts surfaceSeq at 0 — must be accepted, not gap-rejected
    const next = applyServerMessage(r.state, snapshot(0, '2'));
    expect(next.resync).toBe(false);
    expect(next.state.revision).toBe('2');
    // and the prior view is pushed to history (back-navigable)
    expect(next.state.history.length).toBe(1);
  });

  it('rejects an invalid snapshot tree hard, keeping prior state', () => {
    const s = applyServerMessage(initialCanvasState, snapshot(0, '0')).state;
    const bad = { ...snapshot(1, '1'), tree: { type: 'iframe' } } as ServerMessage;
    const r = applyServerMessage(s, bad);
    expect(r.resync).toBe(false);
    expect(r.state.revision).toBe('0');
    expect(r.state.notices.some((n) => n.includes('rejected'))).toBe(true);
  });

  it('accumulates prose and settles the turn', () => {
    let r = applyServerMessage(initialCanvasState, { type: 'agent_text_delta', forTurn: 't1', text: 'Three ' });
    r = applyServerMessage(r.state, { type: 'agent_text_delta', forTurn: 't1', text: 'people' });
    expect(r.state.prose).toBe('Three people');
    r = applyServerMessage(r.state, { type: 'turn_complete', forTurn: 't1' });
    expect(r.state.turnPending).toBe(false);
  });

  it('surfaces turn_error as a notice', () => {
    const r = applyServerMessage(initialCanvasState, { type: 'turn_error', forTurn: 't1', message: 'boom' });
    expect(r.state.notices.some((n) => n.includes('boom'))).toBe(true);
    expect(r.state.turnPending).toBe(false);
  });

  it('exposes turn_error for the beam chip and clears it on turn_complete', () => {
    let r = applyServerMessage(initialCanvasState, snapshot(0, '0'));
    r = applyServerMessage(r.state, { type: 'turn_error', forTurn: 't1', message: 'boom' });
    expect(r.state.turnError).toBe('boom');
    r = applyServerMessage(r.state, snapshot(0, '1'));
    r = applyServerMessage(r.state, { type: 'turn_complete', forTurn: 't2' });
    expect(r.state.turnError).toBe(null);
  });

  it('records a snapshot apply as a crossfade run (visual-spec §6.1)', () => {
    const r = applyServerMessage(initialCanvasState, snapshot(0, '0'));
    expect(r.state.snapshotRevision).toBe('0');
    expect(r.state.lastApply).toMatchObject({ kind: 'snapshot', revision: '0', rapid: false });
  });

  it('marks the deepest patched node for condensation (visual-spec §3.5)', () => {
    let r = applyServerMessage(initialCanvasState, snapshot(0, '0'));
    r = applyServerMessage(
      r.state,
      patch(1, '0', '1', [{ op: 'replace', path: '/children/0/text', value: 'done' }]),
    );
    expect(r.state.lastApply).toMatchObject({ kind: 'patch', revision: '1', rapid: false });
    expect(r.state.lastApply?.changedIds).toEqual(['s']);
    // the snapshot run stays open — patches must not remount the canvas
    expect(r.state.snapshotRevision).toBe('0');
  });

  it('flags rapid-stream when more than 5 patches land within a second', () => {
    let r = applyServerMessage(initialCanvasState, snapshot(0, '0'), 0);
    for (let i = 1; i <= 6; i += 1) {
      r = applyServerMessage(
        r.state,
        patch(i, String(i - 1), String(i), [
          { op: 'replace', path: '/children/0/text', value: `v${i}` },
        ]),
        i * 50, // all six inside the 1s sliding window
      );
    }
    expect(r.state.lastApply?.rapid).toBe(true);
  });
});
