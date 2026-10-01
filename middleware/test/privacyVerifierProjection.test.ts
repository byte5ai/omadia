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
import { countUnresolvedSurrogates } from '@omadia/plugin-privacy-guard/dist/verifierProjection.js';

const TURN = { sessionId: 's-verifier', turnId: 't-verifier' };
const MAIL = 'jana.beispiel@firma.example';
const NAME = 'Jana Beispielfrau';
const DE_MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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

  it('admits a wire-view request (empty text): one request, the map untouched, no C1 call', async () => {
    // The claim extractor's request carries only the turn's wire view, which
    // is never masked twice; it is admitted with an empty verifier-stage text.
    let c1Calls = 0;
    const svc = createPrivacyGuardService({
      readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
      c1Detector: {
        id: 'c1-stub',
        detect: async () => {
          c1Calls += 1;
          return [];
        },
      },
    });
    const turnMask = await svc.maskUserPrompt!({ ...TURN, text: `Bitte an ${MAIL} schreiben.` });
    assert.equal(turnMask.outcome, 'masked');
    const callsAfterTurn = c1Calls;

    const admitted = await svc.maskUserPrompt!({ ...TURN, text: '', stage: 'verifier' });

    assert.deepEqual(admitted, { outcome: 'masked', maskedText: '', spans: [], degraded: false });
    assert.equal(c1Calls, callsAfterTurn, 'an empty text went to the C1 sidecar');
    assert.equal(await svc.restorePromptPseudonyms!(TURN.turnId, turnMask.maskedText), `Bitte an ${MAIL} schreiben.`);
    const receipt = await svc.finalizeTurn(TURN.turnId);
    assert.deepEqual(receipt?.verifierEgress, { requests: 1, maskedSpans: [] });
    assert.equal(receipt?.maskedPromptSpans?.length, 1);
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

  it('concurrent projections of one turn mint distinct placeholders that all restore', async () => {
    // The judge projects its requests in parallel, one per claim, through
    // the one map of the turn.
    const svc = service(false);
    const people = ['Anna Beispiel', 'Bernd Muster', 'Clara Probe'];
    const results = await Promise.all(
      people.map((person) =>
        svc.projectVerifierText!({ ...TURN, text: `Evidenz zu ${person} liegt vor`, identityValues: [person] }),
      ),
    );
    const texts = results.map((r) => (r.outcome === 'masked' ? r.maskedText : ''));
    const placeholders = texts.map((t) => /PLATZHALTER-NAME-\d+/.exec(t)?.[0]);
    assert.equal(
      new Set(placeholders).size,
      people.length,
      `two people share a placeholder: ${placeholders.join(', ')}`,
    );
    const restored = await svc.restorePromptPseudonyms!(TURN.turnId, texts.join(' | '));
    assert.equal(restored, people.map((p) => `Evidenz zu ${p} liegt vor`).join(' | '));
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

  it('finds a date placeholder the model wrote back in another format', async () => {
    const svc = service(true);
    const masked = await svc.maskUserPrompt!({ ...TURN, text: 'Prüfe S1234 und Termin 24.12.1987' });
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    const [placeholder, dd, mm, yyyy] = /(\d{2})\.(\d{2})\.(\d{4})/.exec(masked.maskedText) ?? [];
    assert.ok(placeholder && dd && mm && yyyy, masked.maskedText);
    const [day, month] = [Number(dd), Number(mm)];
    const count = (text: string): Promise<number> =>
      svc.countUnresolvedSurrogates!(TURN.turnId, text);

    for (const rewritten of [
      `${yyyy}-${mm}-${dd}`,
      `${String(day)}.${String(month)}.${yyyy}`,
      `${String(day)}. ${DE_MONTHS[month - 1]!} ${yyyy}`,
      `${EN_MONTHS[month - 1]!} ${String(day)}, ${yyyy}`,
    ]) {
      assert.equal(await count(`S1234 ist bestätigt; Termin ist ${rewritten}.`), 1, rewritten);
    }
    // The restored answer names the real date; other dates are no placeholder.
    const restored = await svc.restorePromptPseudonyms!(TURN.turnId, `Termin ist ${placeholder}.`);
    assert.equal(restored, 'Termin ist 24.12.1987.');
    assert.equal(await count(restored), 0);
    assert.equal(await count('Termin ist 1987-12-24, Abgabe am 2026-10-01.'), 0);
  });

  it('compares dates by value in either direction (ISO placeholder, German rewrite)', () => {
    const map = {
      forward: new Map([['1987-12-24', '1970-01-01']]),
      reverse: new Map([['1970-01-01', '1987-12-24']]),
    };
    assert.equal(countUnresolvedSurrogates('Termin am 01.01.1970', map), 1);
    assert.equal(countUnresolvedSurrogates('Termin am 1. Januar 1970', map), 1);
    assert.equal(countUnresolvedSurrogates('Termin am 24.12.1987', map), 0);
  });

  it('finds an amount placeholder the model wrote back with a scale word', async () => {
    const svc = service(true);
    const masked = await svc.maskUserPrompt!({ ...TURN, text: 'Gehalt 72.000 €' });
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    const units = Number(/€(\d{5})/.exec(masked.maskedText)?.[1]);
    assert.ok(units >= 10000, masked.maskedText);
    const thousands = String(units / 1000).replace('.', ',');
    const count = (text: string): Promise<number> =>
      svc.countUnresolvedSurrogates!(TURN.turnId, text);

    for (const rewritten of [`${thousands} Tsd. €`, `EUR ${thousands}k`, `${thousands} T€`]) {
      assert.equal(await count(`Gehalt ${rewritten}`), 1, rewritten);
    }
    assert.equal(await count('Gehalt 72.000 €'), 0);
    assert.equal(await count(`Gehalt ${String(units / 1000 + 0.5).replace('.', ',')} Tsd. €`), 0);
  });

  it('a value it cannot read counts as a placeholder of its kind (fail closed)', async () => {
    const svc = service(true);
    await svc.maskUserPrompt!({ ...TURN, text: 'Termin 24.12.1987' });
    assert.equal(await svc.countUnresolvedSurrogates!(TURN.turnId, 'Termin ist 31.02.1990.'), 1);
    // A turn that masked no date has no date placeholder to rewrite.
    const mailOnly = { ...TURN, turnId: 't-mail-only' };
    await svc.maskUserPrompt!({ ...mailOnly, text: `Mail an ${MAIL}` });
    assert.equal(await svc.countUnresolvedSurrogates!(mailOnly.turnId, 'Termin ist 31.02.1990.'), 0);
    // An unreadable placeholder matches every date in the text.
    const map = {
      forward: new Map([['24.12.1987', '31.02.1990']]),
      reverse: new Map([['31.02.1990', '24.12.1987']]),
    };
    assert.equal(countUnresolvedSurrogates('Termin ist 2026-10-01.', map), 1);
    assert.equal(countUnresolvedSurrogates('Kein Termin.', map), 0);
  });
});
