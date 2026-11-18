import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildCorrectionPrompt,
  type ClaimVerdict,
  type VerifierVerdict,
} from '@omadia/verifier';

// The correction hint goes to the turn's model, and from there into an
// answer for the turn's user. What the verifier measured is fetched with the
// verifier's own access — a tenant-wide knowledge-graph lookup, the Odoo
// reader of the verifier plugin — not with the user's grants, so none of it
// may ride along: no `truth`, no `detail`. The hint names the claims (the
// answer's own words) and says what to do. All values are synthetic.

const SECRET_TRUTH = 'Gehalt laut HR: 7.200 EUR (Erika Beispiel)';
const SECRET_DETAIL = 'no hr.employee with name="Interne Notiz 4411"';

function contradiction(
  id: string,
  text: string,
  source: 'graph' | 'unknown' = 'graph',
): ClaimVerdict {
  return {
    status: 'contradicted',
    claim: { id, text, type: 'qualitative', expectedSource: 'graph', relatedEntities: [] },
    truth: SECRET_TRUTH,
    source,
    detail: SECRET_DETAIL,
  };
}

function blocked(contradictions: ClaimVerdict[]): VerifierVerdict {
  return { status: 'blocked', claims: contradictions, contradictions, latencyMs: 0 };
}

describe('buildCorrectionPrompt — no verifier evidence in the hint', () => {
  it('names a contradicted claim, never what the check measured', () => {
    const prompt = buildCorrectionPrompt(
      blocked([contradiction('c_1', 'Erika arbeitet im Vertrieb')]),
    );
    assert.ok(prompt);
    assert.match(prompt, /## Falsche \/ widerlegte Daten/);
    assert.match(prompt, /"Erika arbeitet im Vertrieb"/);
    assert.equal(prompt.includes('7.200'), false, 'the measured value reached the hint');
    assert.equal(prompt.includes('Erika Beispiel'), false, 'evidence content reached the hint');
    assert.equal(prompt.includes('Interne Notiz 4411'), false, 'the check’s detail reached the hint');
  });

  it('a replay item names the claim, not the detector’s detail', () => {
    const prompt = buildCorrectionPrompt(
      blocked([contradiction('c_replay_001', 'kein Anhang gefunden', 'unknown')]),
    );
    assert.ok(prompt);
    assert.match(prompt, /## Replay aus Kontext-Block erkannt/);
    assert.match(prompt, /"kein Anhang gefunden"/);
    assert.equal(prompt.includes('Interne Notiz 4411'), false);
    assert.equal(prompt.includes('Erika Beispiel'), false);
  });

  it('tells the model to answer from this turn’s own results', () => {
    const prompt = buildCorrectionPrompt(
      blocked([contradiction('c_1', 'Umsatz 5 Mio')]),
    );
    assert.ok(prompt);
    assert.match(prompt, /Tool-Ergebnisse dieses Turns/);
    assert.equal(/Tatsächlich:/.test(prompt), false, 'no measured value is announced');
  });
});
