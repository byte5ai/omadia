/**
 * Privacy-guard service surface for the answer verifier's post-turn requests:
 * stage accounting in the receipt, the always-on evidence projection, the
 * side-effect-free preview, and the unresolved-surrogate check.
 *
 * Everything runs against the REAL service; values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

const TURN = { sessionId: 's-verifier', turnId: 't-verifier' };
const MAIL = 'jana.beispiel@firma.example';
const NAME = 'Jana Beispielfrau';

function service(maskUserPrompt: boolean): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt' && maskUserPrompt ? 'on' : undefined,
  });
}

describe('privacy-guard — verifier stage accounting', () => {
  it('counts a verifier request even when prompt masking is off', async () => {
    const svc = service(false);
    const result = await svc.maskUserPrompt!({ ...TURN, text: `Mail an ${MAIL}`, stage: 'verifier' });
    assert.equal(result.outcome, 'disabled');
    const receipt = await svc.finalizeTurn(TURN.turnId);
    assert.ok(receipt, 'a turn whose only egress was the verifier still gets a receipt');
    assert.deepEqual(receipt.verifierEgress, { requests: 1, maskedSpans: [] });
    assert.equal(receipt.maskedPromptSpans, undefined);
  });

  it('books verifier spans apart from the turn prompt spans', async () => {
    const svc = service(true);
    await svc.maskUserPrompt!({ ...TURN, text: `Bitte an ${MAIL} schreiben.` });
    const verifier = await svc.maskUserPrompt!({
      ...TURN,
      text: `Bitte an ${MAIL} schreiben.`,
      stage: 'verifier',
    });
    assert.equal(verifier.outcome, 'masked');
    const receipt = await svc.finalizeTurn(TURN.turnId);
    assert.ok(receipt);
    assert.equal(receipt.maskedPromptSpans?.length, 1, 'turn spans unchanged by the verifier');
    assert.equal(receipt.verifierEgress?.requests, 1);
    assert.deepEqual(
      receipt.verifierEgress?.maskedSpans.map((s) => s.type),
      ['email'],
    );
  });

  it('a preview changes nothing: no map entry, no receipt line', async () => {
    const svc = service(true);
    const preview = await svc.maskUserPrompt!({
      ...TURN,
      text: `Bitte an ${MAIL} schreiben.`,
      stage: 'verifier',
      preview: true,
    });
    assert.equal(preview.outcome, 'masked');
    if (preview.outcome === 'masked') assert.notEqual(preview.maskedText.includes(MAIL), true);
    // Nothing was kept: restore has no surrogate to invert, finalize has
    // nothing to report.
    const surrogate = preview.outcome === 'masked' ? preview.maskedText.split(' ')[2]! : '';
    assert.equal(await svc.restorePromptPseudonyms!(TURN.turnId, surrogate), surrogate);
    assert.equal(await svc.finalizeTurn(TURN.turnId), undefined);
  });
});

describe('privacy-guard — verifier evidence projection', () => {
  const EVIDENCE = `CLAIM: ${NAME} leitet das Team\nEVIDENCE: Graph-Node odoo:hr.employee:7 — ${NAME} (department=IT, work_email=${MAIL}, date_start=2023-03-01, wage=5200)`;

  it('masks identity values and identity shapes even with prompt masking off', async () => {
    const svc = service(false);
    const result = await svc.projectVerifierText!({
      ...TURN,
      text: EVIDENCE,
      identityValues: [NAME],
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.deepEqual(findIdentityLeaks(result.maskedText, [NAME, MAIL]), []);
    // One map: the claim subject and the evidence subject are ONE placeholder.
    const names = [...result.maskedText.matchAll(/PLATZHALTER-NAME-\d+/g)].map((m) => m[0]);
    assert.equal(names.length, 2);
    assert.equal(new Set(names).size, 1);
    // Dates and amounts stay, as in a v4 digest.
    assert.match(result.maskedText, /date_start=2023-03-01/);
    assert.match(result.maskedText, /wage=5200/);
    // The rationale the judge writes over placeholders restores to real values.
    assert.equal(
      await svc.restorePromptPseudonyms!(TURN.turnId, `${names[0]!} leitet das Team.`),
      `${NAME} leitet das Team.`,
    );
    const receipt = await svc.finalizeTurn(TURN.turnId);
    assert.equal(receipt?.verifierEgress?.requests, 1);
    assert.ok((receipt?.verifierEgress?.maskedSpans.length ?? 0) >= 3);
  });

  it('reuses the surrogate the turn minted for its own prompt', async () => {
    const svc = service(true);
    // No sentence-final period right after the address: word-boundary
    // extension would fold it into the masked value.
    const turnMask = await svc.maskUserPrompt!({ ...TURN, text: `Schreib an ${MAIL} bitte` });
    assert.equal(turnMask.outcome, 'masked');
    const surrogate =
      turnMask.outcome === 'masked' ? /\S+@example\.net/.exec(turnMask.maskedText)?.[0] : undefined;
    assert.ok(surrogate);
    const projected = await svc.projectVerifierText!({ ...TURN, text: EVIDENCE, identityValues: [NAME] });
    assert.equal(projected.outcome, 'masked');
    if (projected.outcome === 'masked') assert.ok(projected.maskedText.includes(surrogate));
  });

  it('blocks a real value that collides with a surrogate minted this turn', async () => {
    const svc = service(true);
    const turnMask = await svc.maskUserPrompt!({ ...TURN, text: `Schreib an ${MAIL} bitte` });
    const surrogate =
      turnMask.outcome === 'masked' ? /\S+@example\.net/.exec(turnMask.maskedText)?.[0] : undefined;
    assert.ok(surrogate);
    // A real record that happens to hold the surrogate string: masking it
    // would give two people one placeholder.
    const result = await svc.projectVerifierText!({
      ...TURN,
      text: `EVIDENCE: work_email=${surrogate}`,
    });
    assert.equal(result.outcome, 'blocked');
  });
});

describe('privacy-guard — unresolved surrogates', () => {
  it('finds surrogates verbatim, case-changed, or with regrouped digits', async () => {
    const svc = service(true);
    const masked = await svc.maskUserPrompt!({
      ...TURN,
      text: `Mail ${MAIL}, Gehalt 72.000 €`,
    });
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    const email = /\S+@example\.net/.exec(masked.maskedText)?.[0];
    const amount = /€\d{5}/.exec(masked.maskedText)?.[0];
    assert.ok(email && amount, masked.maskedText);
    const digits = amount.replace(/\D/g, '');
    const regrouped = `${digits.slice(0, 2)}.${digits.slice(2)} €`;

    assert.equal(await svc.countUnresolvedSurrogates!(TURN.turnId, 'Alles erledigt.'), 0);
    assert.equal(await svc.countUnresolvedSurrogates!(TURN.turnId, `an ${email}`), 1);
    assert.equal(await svc.countUnresolvedSurrogates!(TURN.turnId, `an ${email.toUpperCase()}`), 1);
    assert.equal(await svc.countUnresolvedSurrogates!(TURN.turnId, `Gehalt ${regrouped}`), 1);
    // The restored text carries the real values only.
    const restored = await svc.restorePromptPseudonyms!(
      TURN.turnId,
      `an ${email}, Gehalt ${amount}`,
    );
    assert.equal(await svc.countUnresolvedSurrogates!(TURN.turnId, restored), 0);
  });
});
