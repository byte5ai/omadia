import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  appendOrphanPlaceholderFooter,
  detectOrphanPlaceholders,
  ORPHAN_PLACEHOLDER_FOOTER_MARKER,
} from '@omadia/orchestrator/dist/orphanPlaceholderCheck.js';

/**
 * Privacy-Engine Hardening Slice #4 — orphan-placeholder detection +
 * footer behaviour.
 *
 * The detection module must recognise every placeholder Phase A.2
 * emits, count duplicates, preserve first-seen order, and the footer
 * helper must be idempotent (re-applying never doubles the footer).
 */

describe('detectOrphanPlaceholders', () => {
  it('returns zero counts for placeholder-free text', () => {
    const result = detectOrphanPlaceholders(
      'Anna Müller ist heute im Urlaub. Sie kehrt am 18.05. zurück.',
    );
    assert.equal(result.count, 0);
    assert.deepEqual(result.types, []);
  });

  it('returns zero counts for empty input', () => {
    const result = detectOrphanPlaceholders('');
    assert.equal(result.count, 0);
    assert.deepEqual(result.types, []);
  });

  it('detects a single [Name] occurrence', () => {
    const result = detectOrphanPlaceholders('Bitte frag [Name] direkt.');
    assert.equal(result.count, 1);
    assert.deepEqual(result.types, ['[Name]']);
  });

  it('counts duplicate placeholders separately but reports each type once', () => {
    const result = detectOrphanPlaceholders(
      'Heute sind [Name], [Name] und [Adresse] nicht erreichbar.',
    );
    assert.equal(result.count, 3);
    assert.deepEqual(result.types, ['[Name]', '[Adresse]']);
  });

  it('detects all Phase-A.2 placeholder types', () => {
    const text =
      'Kontakt: [Name] · [E-Mail] · [Telefon] · [Adresse] · [Organisation] · [IBAN] · [Kreditkarte] · [IP-Adresse] · [Krypto-Adresse] · [Schlüssel] · [ID-Nummer] · [Vertraulich]';
    const result = detectOrphanPlaceholders(text);
    assert.equal(result.count, 12);
    // 12 distinct placeholder kinds
    assert.equal(result.types.length, 12);
    assert.ok(result.types.includes('[Name]'));
    assert.ok(result.types.includes('[Vertraulich]'));
  });

  it('preserves first-seen order for types', () => {
    const result = detectOrphanPlaceholders(
      'Erst [Adresse], dann [Name], dann nochmal [Adresse].',
    );
    assert.deepEqual(result.types, ['[Adresse]', '[Name]']);
  });

  it('does not false-positive on similar but non-placeholder text', () => {
    const result = detectOrphanPlaceholders(
      'Der Begriff "Name" ist hier nur Text, nicht in eckigen Klammern.',
    );
    assert.equal(result.count, 0);
  });
});

describe('appendOrphanPlaceholderFooter', () => {
  it('returns text unchanged when no placeholders are present', () => {
    const text = 'Heute keine Abwesenheiten.';
    const result = appendOrphanPlaceholderFooter(text);
    assert.equal(result, text);
  });

  it('appends a footer when placeholders are present', () => {
    const text = 'Heute ist [Name] krank.';
    const result = appendOrphanPlaceholderFooter(text);
    assert.notEqual(result, text);
    assert.ok(result.startsWith(text));
    assert.match(result, /Hinweis:/);
    assert.match(result, /\[Name\]/);
    assert.match(result, /Privacy-Filter/);
    assert.match(result, /1 Datenfeld/);
  });

  it('singular vs plural German grammar in the footer', () => {
    const single = appendOrphanPlaceholderFooter('1 mal: [Name]');
    assert.match(single, /1 Datenfeld /);
    const multiple = appendOrphanPlaceholderFooter(
      '2 mal: [Name] und [Adresse]',
    );
    assert.match(multiple, /2 Datenfelder /);
  });

  it('lists all distinct placeholder types in the footer', () => {
    const result = appendOrphanPlaceholderFooter(
      '[Name] und [Adresse] und [E-Mail]',
    );
    assert.match(result, /\[Name\], \[Adresse\], \[E-Mail\]/);
  });

  it('is idempotent — re-applying does not double the footer', () => {
    const text = 'Heute ist [Name] krank.';
    const once = appendOrphanPlaceholderFooter(text);
    const twice = appendOrphanPlaceholderFooter(once);
    assert.equal(twice, once);
  });

  it('includes the footer-marker so it can be detected post-hoc', () => {
    const result = appendOrphanPlaceholderFooter('[Name] fehlt');
    assert.ok(result.includes(ORPHAN_PLACEHOLDER_FOOTER_MARKER));
  });

  it('accepts a pre-computed analysis to avoid double-scanning', () => {
    const text = 'Heute ist [Name] krank.';
    const analysis = detectOrphanPlaceholders(text);
    const result = appendOrphanPlaceholderFooter(text, analysis);
    assert.match(result, /1 Datenfeld/);
  });

  it('respects an explicit zero-count analysis even on text that contains placeholders', () => {
    // Defensive — if a caller mutated the input between detect + append,
    // the supplied analysis still wins.
    const result = appendOrphanPlaceholderFooter('[Name] sneaks past', {
      count: 0,
      types: [],
    });
    assert.equal(result, '[Name] sneaks past');
  });
});
