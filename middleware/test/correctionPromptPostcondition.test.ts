import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildCorrectionPrompt,
  type ClaimVerdict,
  type VerifierVerdict,
} from '@omadia/verifier';

// #130 — buildCorrectionPrompt must surface a dedicated postcondition
// section so the orchestrator's retry knows the tool's output didn't
// match its declared schema. This is parallel to the existing replay/
// data sections but with its own remediation: re-call the tool with
// corrected args (or pick a different tool) instead of restating the
// already-measured value.

function postconditionVerdict(callId: string, issues: string[]): ClaimVerdict {
  return {
    status: 'contradicted',
    claim: {
      id: `c_postcond_${callId}`,
      text: "Tool 'list_products' returned a value that did not conform to its declared output schema.",
      type: 'tool_postcondition',
      expectedSource: 'unknown',
      relatedEntities: [],
    },
    truth: { issues },
    source: 'unknown',
    detail: issues.join('; '),
  };
}

function blockedVerdictWith(
  contradictions: ClaimVerdict[],
): VerifierVerdict {
  return {
    status: 'blocked',
    claims: contradictions,
    contradictions,
    latencyMs: 0,
  };
}

describe('buildCorrectionPrompt — postcondition', () => {
  it('emits a Postcondition section for tool_postcondition contradictions', () => {
    const verdict = blockedVerdictWith([
      postconditionVerdict('call_a', ['<root>: expected array, received object']),
    ]);
    const prompt = buildCorrectionPrompt(verdict);
    assert.ok(prompt, 'prompt should be returned for blocked verdict');
    assert.match(prompt, /## Tool-Output nicht spec-konform/);
    assert.match(prompt, /callId=call_a/);
    assert.match(prompt, /expected array, received object/);
  });

  it('keeps postcondition items out of the data/replay sections', () => {
    const verdict = blockedVerdictWith([
      postconditionVerdict('call_b', ['amount.value: required']),
    ]);
    const prompt = buildCorrectionPrompt(verdict);
    assert.ok(prompt);
    assert.doesNotMatch(prompt, /## Falsche \/ widerlegte Daten/);
    assert.doesNotMatch(prompt, /## Replay aus Kontext-Block erkannt/);
  });

  it('returns undefined for non-blocked verdicts', () => {
    const verdict: VerifierVerdict = {
      status: 'approved',
      claims: [],
      latencyMs: 0,
    };
    assert.equal(buildCorrectionPrompt(verdict), undefined);
  });
});
