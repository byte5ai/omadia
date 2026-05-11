import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_ASSET_WEIGHTS,
  FALLBACK_ASSET_WEIGHT,
  computeHealthScore,
} from '../src/profileSnapshots/healthScore.js';
import type { AssetDiff } from '../src/profileSnapshots/snapshotService.js';

/**
 * Phase 2.3 Slice 1 — healthScore pure-function coverage.
 *
 * The score algorithm is a heuristic, but the tests pin down the
 * invariants the operator + UI rely on:
 *  - zero-diff input ⇒ score 100
 *  - critical asset (`agent.md`) diverged ⇒ score 0 + critical suggestion
 *  - identical-status diffs are ignored
 *  - unmatched paths get the fallback weight (low impact)
 *  - suggestion IDs are stable + deduped
 */

const NULL_HASH = null as string | null;

const diff = (
  path: string,
  status: AssetDiff['status'],
): AssetDiff => ({
  path,
  status,
  baseSha256: status === 'added' ? null : NULL_HASH,
  targetSha256: status === 'removed' ? null : NULL_HASH,
});

describe('computeHealthScore', () => {
  it('returns score 100 with no suggestions when there are zero diffs', () => {
    const out = computeHealthScore({ diffs: [] });
    assert.equal(out.score, 100);
    assert.equal(out.divergedAssets.length, 0);
    assert.equal(out.suggestions.length, 0);
  });

  it('ignores identical-status diffs', () => {
    const out = computeHealthScore({
      diffs: [
        diff('agent.md', 'identical'),
        diff('knowledge/spec.json', 'identical'),
      ],
    });
    assert.equal(out.score, 100);
    assert.equal(out.divergedAssets.length, 0);
  });

  it('drops the score to 0 when agent.md diverges (critical)', () => {
    const out = computeHealthScore({ diffs: [diff('agent.md', 'modified')] });
    assert.equal(out.score, 0);
    assert.equal(out.divergedAssets.length, 1);
    const ids = out.suggestions.map((s) => s.id);
    assert.ok(
      ids.includes('agent-md-modified'),
      'expected agent-md-modified suggestion',
    );
    assert.ok(
      ids.includes('score-critical'),
      'expected score-critical suggestion when score < 30',
    );
  });

  it('uses the fallback weight for unmatched paths (low impact)', () => {
    const out = computeHealthScore({
      diffs: [diff('readme.md', 'modified')],
    });
    // FALLBACK_ASSET_WEIGHT (0.1) over maxWeight (1.0) = 10 points off.
    assert.equal(out.score, 90);
    assert.equal(out.divergedAssets[0]?.weight, FALLBACK_ASSET_WEIGHT);
    // Score >= 70 → no score-warn suggestion. No path-specific match either.
    assert.equal(out.suggestions.length, 0);
  });

  it('emits warn-level score-warn between 30..69', () => {
    const out = computeHealthScore({
      diffs: [
        diff('knowledge/spec.json', 'modified'), // 0.8
      ],
    });
    // 100 - 0.8 * 100 / 1.0 = 20. Score 20 -> <30 -> critical.
    assert.equal(out.score, 20);
    assert.ok(out.suggestions.some((s) => s.id === 'score-critical'));
  });

  it('dedupes suggestions across multiple matching diverged assets', () => {
    const out = computeHealthScore({
      diffs: [
        diff('plugins/foo-1.0.0.zip', 'added'),
        diff('plugins/bar-2.0.0.zip', 'modified'),
      ],
    });
    const pluginSuggestions = out.suggestions.filter(
      (s) => s.id === 'plugins-modified',
    );
    assert.equal(pluginSuggestions.length, 1);
    assert.equal(pluginSuggestions[0]?.severity, 'critical');
  });

  it('respects custom weights when provided', () => {
    const out = computeHealthScore({
      diffs: [diff('config.yaml', 'modified')],
      weights: [{ pattern: 'config.yaml', weight: 0.5 }],
    });
    // maxWeight = 0.5 (only weight). 100 - 0.5*100/0.5 = 0.
    assert.equal(out.score, 0);
    assert.equal(out.divergedAssets[0]?.weight, 0.5);
  });

  it('produces stable, well-formed suggestion shape', () => {
    const out = computeHealthScore({
      diffs: [diff('agent.md', 'modified')],
    });
    for (const s of out.suggestions) {
      assert.ok(s.id.length > 0, 'suggestion id non-empty');
      assert.ok(
        ['info', 'warn', 'critical'].includes(s.severity),
        `severity must be one of info|warn|critical, got ${s.severity}`,
      );
      assert.ok(s.message.length > 0, 'suggestion message non-empty');
    }
  });

  it('exports DEFAULT_ASSET_WEIGHTS with the contract patterns', () => {
    const patterns = DEFAULT_ASSET_WEIGHTS.map((w) => w.pattern);
    assert.ok(patterns.includes('agent.md'));
    assert.ok(patterns.includes('knowledge/spec.json'));
    assert.ok(patterns.includes('plugins/'));
    assert.ok(patterns.includes('knowledge/'));
  });
});
