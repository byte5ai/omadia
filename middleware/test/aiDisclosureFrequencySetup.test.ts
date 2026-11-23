// #2087 — the operator setting reaches the posture, /health and the boot log.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeAiDisclosurePosture,
  formatDisclosureBootWarning,
} from '@omadia/orchestrator';
import { buildDisclosureHealth } from '../src/health/disclosureHealth.js';

describe('AI disclosure frequency posture (#2087)', () => {
  it('is quiet at the delivered state', () => {
    const posture = describeAiDisclosurePosture(undefined);
    assert.equal(posture.frequency, 'channel_default');
    assert.equal(posture.frequencyDeviates, false);
    assert.equal(posture.deviates, false);
    assert.equal(formatDisclosureBootWarning(posture), undefined);
    const health = buildDisclosureHealth(posture);
    assert.equal(health.frequency, 'channel_default');
    assert.deepEqual(health.warnings, []);
  });

  it('reports a deviating frequency in the posture, /health and the boot log', () => {
    const posture = describeAiDisclosurePosture({ level: 'standard', frequency: 'per_conversation' });
    assert.equal(posture.frequency, 'per_conversation');
    assert.equal(posture.deviates, true);
    assert.match(formatDisclosureBootWarning(posture) ?? '', /frequency=per_conversation/);
    const health = buildDisclosureHealth(posture);
    assert.equal(health.deviates, true);
    assert.equal(health.frequency, 'per_conversation');
    assert.ok(health.warnings.some((w) => /frequency/.test(w)));
  });

  it('treats a publisher without the field as channel_default', () => {
    const posture = describeAiDisclosurePosture(undefined);
    const { frequency: _omit, ...older } = posture;
    void _omit;
    assert.equal(buildDisclosureHealth(older).frequency, 'channel_default');
  });
});
