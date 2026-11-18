/**
 * Dates and amounts read as values — the grammar behind the unresolved-
 * placeholder check (`countUnresolvedSurrogates`). A placeholder the model
 * wrote back in another spelling must read as the same value; every value an
 * ambiguous literal can denote counts; a date that names no calendar day
 * yields none (the caller then fails closed). Values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { detectBaselineSync } from '@omadia/plugin-privacy-guard/dist/promptMask.js';
import {
  asValueLiteral,
  findValueLiterals,
  type ValueKind,
} from '@omadia/plugin-privacy-guard/dist/valueLiterals.js';

/** The distinct values of every `kind` literal in `text`, sorted. */
function valuesOf(text: string, kind: ValueKind): string[] {
  const values = findValueLiterals(text)
    .filter((literal) => literal.kind === kind)
    .flatMap((literal) => literal.values);
  return [...new Set(values)].sort();
}

/** Every month name the C0 date detector masks, by month (six locales). */
const C0_MONTHS: readonly (readonly string[])[] = [
  ['Januar', 'January', 'janvier', 'enero', 'gennaio', 'januari'],
  ['Februar', 'February', 'février', 'febrero', 'febbraio', 'februari'],
  ['März', 'March', 'mars', 'marzo', 'maart'],
  ['April', 'avril', 'abril', 'aprile'],
  ['Mai', 'May', 'mayo', 'maggio', 'mei'],
  ['Juni', 'June', 'juin', 'junio', 'giugno'],
  ['Juli', 'July', 'juillet', 'julio', 'luglio'],
  ['August', 'août', 'agosto', 'augustus'],
  ['September', 'septembre', 'septiembre', 'settembre'],
  ['Oktober', 'October', 'octobre', 'octubre', 'ottobre'],
  ['November', 'novembre', 'noviembre'],
  ['Dezember', 'December', 'décembre', 'diciembre', 'dicembre'],
];

describe('value literals — dates', () => {
  it('reads every written date the C0 detector masks, in all six locales', () => {
    C0_MONTHS.forEach((names, index) => {
      const month = String(index + 1).padStart(2, '0');
      for (const name of names) {
        const text = `am 15 ${name} 1990`;
        assert.ok(
          detectBaselineSync(text).some((span) => span.type === 'date'),
          `the C0 detector no longer masks "${text}"`,
        );
        assert.deepEqual(valuesOf(text, 'date'), [`1990-${month}-15`], text);
      }
    });
  });

  it('reads one day in the spellings a model rewrites a placeholder into', () => {
    for (const text of [
      '01.01.1970',
      '1.1.1970',
      '1. 1. 1970',
      '1970-01-01',
      '1970-01-01T09:30:00Z',
      '1970/01/01',
      '1. Januar 1970',
      '1er janvier 1970',
      '1 de enero de 1970',
      '1st of January, 1970',
      'January 1, 1970',
      'Jan. 1st 1970',
      '01. Jan. 1970',
    ]) {
      assert.deepEqual(valuesOf(`Termin: ${text}.`, 'date'), ['1970-01-01'], text);
    }
  });

  it('keeps every reading of an ambiguous date', () => {
    assert.deepEqual(valuesOf('am 01/05/1978', 'date'), ['1978-01-05', '1978-05-01']);
    assert.deepEqual(valuesOf('am 1.1.70', 'date'), ['1970-01-01', '2070-01-01']);
    assert.deepEqual(valuesOf('am 24.12.1987', 'date'), ['1987-12-24']);
    assert.deepEqual(valuesOf('am 12/24/1987', 'date'), ['1987-12-24']);
  });

  it('a date shape that names no calendar day is read, without a value', () => {
    for (const text of ['31.02.1990', '1990-02-30', '31. Februar 1990', '29.02.1900']) {
      const dates = findValueLiterals(`am ${text}`).filter((l) => l.kind === 'date');
      assert.equal(dates.length, 1, text);
      assert.deepEqual(dates[0]!.values, [], text);
    }
    assert.deepEqual(valuesOf('am 29.02.2000', 'date'), ['2000-02-29']);
  });

  it('ignores numbers that are no date', () => {
    for (const text of ['Version 1.2.3', 'Abschnitt 4.13.2', 'Seite 12', 'Konto 1.234.567', '10.000 €']) {
      assert.deepEqual(valuesOf(text, 'date'), [], text);
    }
    // A list item is no date part: line breaks never join one.
    assert.deepEqual(valuesOf('1.\n1.\n1970 war ein Jahr', 'date'), []);
  });
});

describe('value literals — amounts', () => {
  it('reads groupings, decimals and scale words as one value', () => {
    for (const text of [
      '€10000',
      '10.000 €',
      '10.000,00 €',
      '10,000.00 USD',
      '10 000 €',
      '10\u00a0000 €',
      '10\u202f000 €',
      "CHF 10'000",
      '10.000,- €',
      'EUR 10000',
      '10000 Euro',
      '10k €',
      'EUR 10k',
      '10 Tsd. €',
      '10 Tausend Euro',
      '10 T€',
      '10 TEUR',
      '0,01 Mio. €',
    ]) {
      assert.ok(valuesOf(`Betrag: ${text}`, 'amount').includes('10000'), text);
    }
    assert.deepEqual(valuesOf('1.234,56 €', 'amount'), ['1234.56']);
    assert.deepEqual(valuesOf('10,5 Tsd. €', 'amount'), ['10500']);
  });

  it('keeps both readings of a three-digit group', () => {
    assert.deepEqual(valuesOf('10.000 €', 'amount'), ['10', '10000']);
    assert.deepEqual(valuesOf('1.000.000 €', 'amount'), ['1000000']);
  });

  it('needs a currency or a scale word next to the currency', () => {
    for (const text of ['10.000', 'Raum 10000', '10 km', '24.12.1987']) {
      assert.deepEqual(valuesOf(text, 'amount'), [], text);
    }
  });
});

describe('value literals — one literal as a whole', () => {
  it('is the literal only when the whole text is one', () => {
    assert.deepEqual(asValueLiteral('01.01.1970')?.values, ['1970-01-01']);
    assert.equal(asValueLiteral('€10000')?.kind, 'amount');
    assert.deepEqual(asValueLiteral('€10000')?.values, ['10000']);
    for (const text of ['Musterstraße 1, 10000 Musterstadt', 'lukas.becker@example.net', 'am 01.01.1970']) {
      assert.equal(asValueLiteral(text), undefined, text);
    }
  });
});
