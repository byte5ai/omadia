import { describe, expect, it } from 'vitest';

import type { QualityConfig } from '../builderTypes';
import {
  countHardConflicts,
  detectPersonaConflicts,
} from '../personaConflicts';
import type { PersonaConfig } from '../personaTypes';

/**
 * Phase 3 / OB-67 Slice 3 — pure-function tests for the persona × quality
 * conflict detector. Mirrors persona-ui-v1.md §6.2 trigger table.
 */
describe('detectPersonaConflicts', () => {
  it('returns no warnings on empty inputs', () => {
    expect(detectPersonaConflicts(undefined, undefined)).toEqual([]);
    expect(detectPersonaConflicts({}, {})).toEqual([]);
    expect(detectPersonaConflicts({}, { axes: {} })).toEqual([]);
  });

  it('hard: sycophancy=high + directness ≤ 30 (devils-advocate vs diplomatic)', () => {
    const q: QualityConfig = { sycophancy: 'high' };
    const p: PersonaConfig = { axes: { directness: 25 } };
    const warnings = detectPersonaConflicts(q, p);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('hard');
    expect(warnings[0]!.axes).toContain('quality.sycophancy');
    expect(warnings[0]!.axes).toContain('persona.directness');
    expect(countHardConflicts(warnings)).toBe(1);
  });

  it('soft: sycophancy=high + directness ≥ 70 (reinforcement)', () => {
    const q: QualityConfig = { sycophancy: 'high' };
    const p: PersonaConfig = { axes: { directness: 80 } };
    const warnings = detectPersonaConflicts(q, p);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('soft');
    expect(countHardConflicts(warnings)).toBe(0);
  });

  it('boundary: sycophancy=high + directness=30 → hard (≤30 is inclusive)', () => {
    const warnings = detectPersonaConflicts(
      { sycophancy: 'high' },
      { axes: { directness: 30 } },
    );
    expect(warnings.some((w) => w.severity === 'hard')).toBe(true);
  });

  it('boundary: sycophancy=high + directness=70 → soft (≥70 is inclusive)', () => {
    const warnings = detectPersonaConflicts(
      { sycophancy: 'high' },
      { axes: { directness: 70 } },
    );
    expect(warnings.some((w) => w.severity === 'soft')).toBe(true);
  });

  it('mid-range directness with sycophancy=high → no warnings', () => {
    expect(
      detectPersonaConflicts(
        { sycophancy: 'high' },
        { axes: { directness: 50 } },
      ),
    ).toEqual([]);
  });

  it('soft hint: sycophancy=off + directness ≥ 90', () => {
    const warnings = detectPersonaConflicts(
      { sycophancy: 'off' },
      { axes: { directness: 95 } },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('soft');
    expect(warnings[0]!.id).toMatch(/sycophancy-off/);
  });

  it('soft cluster: formality ≥ 80 + humor ≥ 70', () => {
    const warnings = detectPersonaConflicts(
      undefined,
      { axes: { formality: 85, humor: 75 } },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toMatch(/formality.*humor/);
  });

  it('soft: sarcasm ≥ 70 + warmth ≥ 70 contradicts', () => {
    const warnings = detectPersonaConflicts(
      undefined,
      { axes: { sarcasm: 80, warmth: 90 } },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toMatch(/sarcasm.*warmth/);
  });

  it('multiple conflicts compound (hard + soft together)', () => {
    const warnings = detectPersonaConflicts(
      { sycophancy: 'high' },
      { axes: { directness: 25, formality: 90, humor: 80 } },
    );
    // hard (sycophancy/directness) + soft (formality/humor)
    expect(warnings).toHaveLength(2);
    expect(countHardConflicts(warnings)).toBe(1);
  });

  it('axis defaults to neutral 50 when unset', () => {
    // No axis values → no conflicts even with sycophancy=high
    expect(
      detectPersonaConflicts({ sycophancy: 'high' }, { axes: {} }),
    ).toEqual([]);
  });

  it('warning ids are stable across runs (for React keys)', () => {
    const a = detectPersonaConflicts(
      { sycophancy: 'high' },
      { axes: { directness: 20 } },
    );
    const b = detectPersonaConflicts(
      { sycophancy: 'high' },
      { axes: { directness: 20 } },
    );
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});

describe('countHardConflicts', () => {
  it('counts only hard severity', () => {
    expect(
      countHardConflicts([
        { severity: 'soft', id: 'a', axes: [], message: '' },
        { severity: 'hard', id: 'b', axes: [], message: '' },
        { severity: 'hard', id: 'c', axes: [], message: '' },
      ]),
    ).toBe(2);
    expect(countHardConflicts([])).toBe(0);
  });
});
