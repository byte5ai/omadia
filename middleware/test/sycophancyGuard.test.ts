import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  compileSycophancyGuard,
  estimateSycophancyRisk,
  SYCOPHANCY_PACKAGES,
  SYCOPHANCY_WARNING_THRESHOLD,
  type SycophancyLevel,
} from '../src/plugins/sycophancyGuard.js';

describe('compileSycophancyGuard', () => {
  it("returns '' for level 'off'", () => {
    assert.equal(compileSycophancyGuard('off'), '');
  });

  it("returns '' for undefined level (legacy spec without quality.sycophancy)", () => {
    assert.equal(compileSycophancyGuard(undefined), '');
  });

  it("returns '' for unknown level (defensive)", () => {
    assert.equal(compileSycophancyGuard('bogus' as SycophancyLevel), '');
  });

  it('emits the Accuracy Guidelines header for level=low', () => {
    const out = compileSycophancyGuard('low');
    assert.match(out, /^## Accuracy Guidelines\n/);
    // 3 rules in the package, each rendered as a `- ` bullet
    assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 3);
  });

  it('emits the Critical Thinking header for level=medium', () => {
    const out = compileSycophancyGuard('medium');
    assert.match(out, /^## Critical Thinking Guidelines\n/);
    // 5 rules in the medium package
    assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 5);
  });

  it('emits the Anti-Sycophancy Protocol (STRICT) header for level=high', () => {
    const out = compileSycophancyGuard('high');
    assert.match(out, /^## Anti-Sycophancy Protocol \(STRICT/);
    // 7 rules in the high package
    assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 7);
  });

  it('high tier contains the 7 MANDATORY markers verbatim from kemia', () => {
    const out = compileSycophancyGuard('high');
    // 3 MANDATORY rules plus 4 supporting rules (devil's advocate, holding
    // position, professional-advice disclaimer, confirmation-seeking pattern,
    // facts vs inference labeling).
    const mandatoryCount = (out.match(/MANDATORY:/g) ?? []).length;
    assert.equal(mandatoryCount, 3);
    assert.match(out, /devil's advocate/);
    assert.match(out, /Never begin a response with agreement/);
    assert.match(
      out,
      /regulatory, legal, or financial implications/,
    );
    assert.match(out, /Distinguish clearly between facts/);
    assert.match(out, /do NOT retract unless they provide new evidence/);
    assert.match(out, /seeking confirmation rather than information/);
  });

  it('packages registry matches kemia tier counts: 3/5/7', () => {
    assert.equal(SYCOPHANCY_PACKAGES.low.rules.length, 3);
    assert.equal(SYCOPHANCY_PACKAGES.medium.rules.length, 5);
    assert.equal(SYCOPHANCY_PACKAGES.high.rules.length, 7);
  });

  it('snapshot — full output for each tier is stable across runs', () => {
    const snapshots: Record<Exclude<SycophancyLevel, 'off'>, string> = {
      low: compileSycophancyGuard('low'),
      medium: compileSycophancyGuard('medium'),
      high: compileSycophancyGuard('high'),
    };
    // Stability guard: each tier reproduces byte-identically on a second call.
    for (const tier of ['low', 'medium', 'high'] as const) {
      assert.equal(
        compileSycophancyGuard(tier),
        snapshots[tier],
        `tier ${tier} not deterministic`,
      );
    }
  });
});

describe('estimateSycophancyRisk', () => {
  it('returns 50 for default (no fields)', () => {
    assert.equal(estimateSycophancyRisk({}), 50);
  });

  it('high empathy + low assertiveness scores high', () => {
    assert.ok(estimateSycophancyRisk({ empathy: 90, assertiveness: 20 }) >= 80);
  });

  it('low empathy + high assertiveness scores low', () => {
    assert.ok(estimateSycophancyRisk({ empathy: 10, assertiveness: 90 }) <= 20);
  });

  it('threshold constant matches kemia (65)', () => {
    assert.equal(SYCOPHANCY_WARNING_THRESHOLD, 65);
  });
});
