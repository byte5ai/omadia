import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldTriggerVerifier } from '@omadia/verifier';

describe('verifier/triggerRouter', () => {
  it('returns false on empty input', () => {
    const r = shouldTriggerVerifier('');
    assert.equal(r.shouldVerify, false);
    assert.deepEqual(r.reasons, []);
  });

  it('returns false for smalltalk without numbers', () => {
    const r = shouldTriggerVerifier('Hallo, was kann ich für dich tun?');
    assert.equal(r.shouldVerify, false);
  });

  it('does not trigger on incidental small numbers in prose', () => {
    const r = shouldTriggerVerifier('Es gibt 3 Module für die Buchhaltung.');
    assert.equal(r.shouldVerify, false);
  });

  it('triggers on EUR amounts', () => {
    const r = shouldTriggerVerifier('Die Rechnung beträgt 1.234,56 €.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('currency'));
  });

  it('triggers on amount with suffix EUR', () => {
    const r = shouldTriggerVerifier('Total: 500 EUR offen');
    assert.equal(r.shouldVerify, true);
  });

  it('triggers on Odoo-style invoice reference', () => {
    const r = shouldTriggerVerifier('Rechnung INV/2026/0042 ist offen.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('accounting_ref'));
  });

  it('triggers on ISO date', () => {
    const r = shouldTriggerVerifier('Fällig am 2026-04-19.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('date'));
  });

  it('triggers on German date', () => {
    const r = shouldTriggerVerifier('Fällig am 19.04.2026.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('date'));
  });

  it('triggers on HR durations (Urlaubstage)', () => {
    const r = shouldTriggerVerifier('John hat 12 Urlaubstage genommen.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('hr_duration'));
  });

  it('triggers on working hours', () => {
    const r = shouldTriggerVerifier('Das Projekt hat 42,5 Stunden gebraucht.');
    assert.equal(r.shouldVerify, true);
  });

  it('triggers on percent values', () => {
    const r = shouldTriggerVerifier('Auslastung liegt bei 87,5 %.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('percent'));
  });

  it('triggers on aggregate keyword combined with large number', () => {
    const r = shouldTriggerVerifier('Die Summe beträgt 125000.');
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('aggregate_keyword_with_number'));
  });

  it('does not trigger on aggregate keyword without number', () => {
    const r = shouldTriggerVerifier('Die Summe ist noch unklar.');
    assert.equal(r.shouldVerify, false);
  });

  it('does not trigger on small number even with aggregate word', () => {
    // "3 offene Rechnungen" is a count but without amount-level precision —
    // the claim extractor would still treat it as qualitative, no need to
    // run the whole pipeline for a two-digit count.
    const r = shouldTriggerVerifier('Anzahl: 3 offene Items.');
    assert.equal(r.shouldVerify, false);
  });

  it('returns multiple reasons when several signals match', () => {
    const r = shouldTriggerVerifier(
      'Rechnung INV/2026/0042 über 1.234,56 € fällig am 2026-04-19.',
    );
    assert.equal(r.shouldVerify, true);
    assert.ok(r.reasons.includes('currency'));
    assert.ok(r.reasons.includes('accounting_ref'));
    assert.ok(r.reasons.includes('date'));
  });
});
