/**
 * Prompt-surrogate shapes the model must not trip over, and the restore that
 * reads them back:
 *   - #1555 IBAN surrogates have the 22 characters of a German IBAN;
 *   - #1577 amount/date surrogates are plausible, value-unique, and restored
 *     when the model re-spells them;
 *   - #1545 a first or last name of a person surrogate is restored alone;
 *   - #1554 an e-mail surrogate never contradicts the name next to it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  countUnresolvedForms,
  isReservedSurrogateShape,
  resolvePromptPseudonyms,
} from '@omadia/plugin-privacy-guard/dist/promptSurrogates.js';
import {
  createPromptPseudonymMap,
  FIRST_NAMES,
  LAST_NAMES,
  type PromptSpanValue,
} from '@omadia/plugin-privacy-guard/dist/v4/pseudonym.js';
import type { PseudonymMap } from '@omadia/plugin-privacy-guard/dist/v4/types.js';
import { countUnresolvedSurrogates } from '@omadia/plugin-privacy-guard/dist/verifierProjection.js';

function mapOf(pairs: ReadonlyArray<readonly [string, string]>): PseudonymMap {
  return {
    forward: new Map(pairs.map(([real, surrogate]) => [real, surrogate])),
    reverse: new Map(pairs.map(([real, surrogate]) => [surrogate, real])),
  };
}

function spans(type: string, values: readonly string[]): PromptSpanValue[] {
  return values.map((value) => ({ value, type }));
}

/** The surrogates minted for `values` of one type, in value order. */
function surrogatesFor(type: string, values: readonly string[], text = ''): string[] {
  const map = createPromptPseudonymMap(spans(type, values), text);
  return values.map((v) => map.forward.get(v)!);
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('#1555 IBAN surrogate length', () => {
  it('has the 22 characters of a German IBAN, check digits 00, for the first 2000 candidates', () => {
    const reals = range(2000).map((i) => `DE89 3704 0044 0532 ${String(1000 + i)} 00`);
    const surrogates = surrogatesFor('iban', reals);
    assert.equal(new Set(surrogates).size, surrogates.length);
    for (const s of surrogates) {
      assert.equal(s.length, 22, s);
      assert.match(s, /^DE00\d{18}$/);
    }
  });
});

describe('#1577 amount and date surrogates', () => {
  it('mints non-round five-digit amounts', () => {
    for (const s of surrogatesFor('amount', range(200).map((i) => `${String(i + 1)},00 €`))) {
      assert.match(s, /^€\d{5}$/);
      assert.notEqual(Number(s.slice(1)) % 100, 0, s);
    }
  });

  it('mints plausible recent dates — never the epoch, never a 1st of January', () => {
    const surrogates = surrogatesFor('date', range(400).map((i) => `${String(1 + (i % 28))}.${String(1 + (i % 12))}.19${String(10 + (i % 80))}`));
    assert.equal(new Set(surrogates).size, surrogates.length);
    for (const s of surrogates) {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
      assert.ok(m, s);
      const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
      assert.ok(year >= 2003 && year <= 2022, s);
      assert.ok(day >= 2 && day <= 27, s);
      assert.ok(month >= 1 && month <= 12, s);
    }
  });

  it('never mints a surrogate whose VALUE a real value or a literal of the text names', () => {
    // The first amount candidate is €12357 — taken by value by the real
    // amount in another spelling, and by a literal the prompt carries.
    const [own] = surrogatesFor('amount', ['12.357,00 €']);
    assert.notEqual(own, '€12357');
    const [byText] = surrogatesFor('amount', ['5 €'], 'Budget EUR 12.357, davon 5 €');
    assert.notEqual(byText, '€12357');
    const [first] = surrogatesFor('date', ['01.05.1999']);
    const [, d, m, y] = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(first!)!;
    const iso = `${y!}-${m!}-${d!}`;
    const [byDate] = surrogatesFor('date', ['01.05.1999'], `Termin am ${iso} und am 01.05.1999`);
    assert.notEqual(byDate, first);
  });

  const text = 'Jonas hat am 02.10.2026 eine Rechnung über 1.250,00 € geschickt.';
  const map = createPromptPseudonymMap(
    [
      { value: '02.10.2026', type: 'date' },
      { value: '1.250,00 €', type: 'amount' },
    ],
    text,
  );
  const amount = map.forward.get('1.250,00 €')!;
  const date = map.forward.get('02.10.2026')!;
  const digits = amount.slice(1);
  const [, dd, mm, yyyy] = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date)!;
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

  it('restores a re-spelled amount surrogate to the amount the user wrote', () => {
    const grouped = `${digits.slice(0, 2)}.${digits.slice(2)}`;
    for (const spelling of [`${grouped} €`, `EUR ${grouped}`, `${grouped},00 €`, `€${digits},00`, amount]) {
      const answer = `Rechnung über ${spelling} bestätigt.`;
      const restored = resolvePromptPseudonyms(answer, map);
      assert.equal(restored, 'Rechnung über 1.250,00 € bestätigt.', spelling);
      assert.equal(countUnresolvedSurrogates(restored, map), 0, spelling);
    }
  });

  it('restores a re-spelled date surrogate to the date the user wrote', () => {
    for (const spelling of [
      `${yyyy!}-${mm!}-${dd!}`,
      `${String(Number(dd))}. ${MONTHS[Number(mm) - 1]!} ${yyyy!}`,
      date,
    ]) {
      const restored = resolvePromptPseudonyms(`Rechnung vom ${spelling}.`, map);
      assert.equal(restored, 'Rechnung vom 02.10.2026.', spelling);
    }
  });

  it('restores date and amount in one pass, the exact forms not twice', () => {
    assert.equal(
      resolvePromptPseudonyms(`Am ${date} über ${amount}; also ${amount}.`, map),
      'Am 02.10.2026 über 1.250,00 €; also 1.250,00 €.',
    );
  });

  it('leaves a literal that names more than one surrogate (or none) as written', () => {
    const ambiguous = mapOf([
      ['5 €', '€12357'],
      ['7 €', '€12.357'],
    ]);
    assert.equal(resolvePromptPseudonyms('Es sind 12.357 €.', ambiguous), 'Es sind 12.357 €.');
    assert.equal(resolvePromptPseudonyms('Es sind 99.999 €.', map), 'Es sind 99.999 €.');
  });
});

describe('#1545 person surrogate parts', () => {
  it('pools hold 24 names each and none of the dangerous ordinary words', () => {
    assert.equal(FIRST_NAMES.length, 24);
    assert.equal(LAST_NAMES.length, 24);
    for (const word of ['Jan', 'Max']) assert.ok(!FIRST_NAMES.includes(word), word);
    for (const word of ['Richter', 'Klein', 'Wolf', 'Schwarz', 'Braun', 'Lange', 'Krause', 'Frank', 'Vogel', 'Sommer']) {
      assert.ok(!LAST_NAMES.includes(word), word);
    }
  });

  it('the first 24 person surrogates differ in both first and last name', () => {
    const surrogates = surrogatesFor('person', range(24).map((i) => `Real Person${String.fromCharCode(65 + i)}`));
    const firsts = surrogates.map((s) => s.split(' ')[0]);
    const lasts = surrogates.map((s) => s.split(' ')[1]);
    assert.equal(new Set(firsts).size, 24);
    assert.equal(new Set(lasts).size, 24);
  });

  const text = 'Mein Kollege Jonas Weber — formuliere eine Begrüßungsmail an ihn.';
  const map = createPromptPseudonymMap([{ value: 'Jonas Weber', type: 'person' }], text);
  const [first, last] = map.forward.get('Jonas Weber')!.split(' ') as [string, string];

  it('restores a first name, a last name and a salutation on their own', () => {
    assert.equal(resolvePromptPseudonyms(`Hallo ${first},`, map), 'Hallo Jonas,');
    assert.equal(resolvePromptPseudonyms(`Sehr geehrter Herr ${last},`, map), 'Sehr geehrter Herr Weber,');
    assert.equal(resolvePromptPseudonyms(`HALLO ${first.toUpperCase()}`, map), 'HALLO JONAS');
    assert.equal(resolvePromptPseudonyms(`${first} ${last} kommt.`, map), 'Jonas Weber kommt.');
    assert.equal(countUnresolvedForms(`Hallo ${first}`, map), 0);
  });

  it('matches parts case-sensitively and on word boundaries only', () => {
    const lower = `die ${first.toLowerCase()} und ${last.toLowerCase()}`;
    assert.equal(resolvePromptPseudonyms(lower, map), lower);
    const glued = `${first}s Mail, ${last}straße`;
    assert.equal(resolvePromptPseudonyms(glued, map), glued);
  });

  it('a part next to another name word may be someone else: kept and counted, not renamed', () => {
    const other = `Laut Odoo ist ${first} Schmidt zuständig, Kollege ${last} auch.`;
    assert.equal(resolvePromptPseudonyms(other, map), other);
    assert.equal(countUnresolvedForms(other, map), 2);
  });

  it('a part shared by two people, or of a one-word real name, stays and is counted', () => {
    const shared = mapOf([
      ['Jonas Weber', 'Lukas Becker'],
      ['Anna Meier', 'Lukas Schulz'],
    ]);
    assert.equal(resolvePromptPseudonyms('Hallo Lukas, Herr Becker', shared), 'Hallo Lukas, Herr Weber');
    assert.equal(countUnresolvedForms('Hallo Lukas', shared), 1);
    // The full names still restore; their parts are not counted.
    assert.equal(resolvePromptPseudonyms('Lukas Schulz', shared), 'Anna Meier');
    assert.equal(countUnresolvedForms('Lukas Becker und Lukas Schulz', shared), 0);

    const single = mapOf([['Jonas', 'Mia Schulz']]);
    assert.equal(resolvePromptPseudonyms('Hallo Mia', single), 'Hallo Mia');
    assert.equal(countUnresolvedForms('Hallo Mia', single), 1);
  });

  it('never mints a part that is a word of the prompt', () => {
    const prompt = 'Lukas sagt, Anna Schmidt und Mia Becker sollen das Schulz-Konzept lesen.';
    const minted = createPromptPseudonymMap(
      spans('person', ['Anna Schmidt', 'Mia Becker']),
      prompt,
    );
    const words = new Set(prompt.toLowerCase().match(/[\p{L}\p{N}_]+/gu));
    for (const surrogate of minted.reverse.keys()) {
      for (const part of surrogate.split(' ')) assert.ok(!words.has(part.toLowerCase()), surrogate);
    }
  });
});

describe('#1554 e-mail surrogate next to a name', () => {
  it('follows the person surrogate when the name is masked too', () => {
    const map = createPromptPseudonymMap(
      [
        { value: 'jonas.weber@example.com', type: 'email' },
        { value: 'Jonas Weber', type: 'person' },
      ],
      'Mein Kollege Jonas Weber, jonas.weber@example.com',
    );
    const person = map.forward.get('Jonas Weber')!;
    const [first, last] = person.toLowerCase().split(' ');
    assert.equal(map.forward.get('jonas.weber@example.com'), `${first!}.${last!}@example.net`);
    // Restore of the derived forms agrees with the person.
    assert.equal(resolvePromptPseudonyms(`${first!}.${last!}`, map), 'jonas.weber');
  });

  it('a second address of the same person gets a numbered variant', () => {
    const map = createPromptPseudonymMap(
      [
        { value: 'jonas.weber@example.com', type: 'email' },
        { value: 'jonas_weber@firma.de', type: 'email' },
        { value: 'Jonas Weber', type: 'person' },
      ],
      'Jonas Weber, jonas.weber@example.com, jonas_weber@firma.de',
    );
    const [first, last] = map.forward.get('Jonas Weber')!.toLowerCase().split(' ');
    assert.deepEqual(
      [map.forward.get('jonas.weber@example.com'), map.forward.get('jonas_weber@firma.de')].sort(),
      [`${first!}.${last!}2@example.net`, `${first!}.${last!}@example.net`],
    );
  });

  it('names nobody when the name stays readable in clear', () => {
    const map = createPromptPseudonymMap(
      [{ value: 'jonas.weber@example.com', type: 'email' }],
      'Mein Kollege Jonas Weber, jonas.weber@example.com, bekommt die Einladung.',
    );
    const surrogate = map.forward.get('jonas.weber@example.com')!;
    assert.match(surrogate, /^kontakt\d+@example\.net$/);
    assert.ok(!isReservedSurrogateShape(surrogate), 'a neutral address is re-masked on replay');
    assert.equal(resolvePromptPseudonyms(`Mail an ${surrogate}`, map), 'Mail an jonas.weber@example.com');
  });

  it('keeps the name pool when no name is in sight', () => {
    const map = createPromptPseudonymMap(
      [{ value: 'jonas.weber@example.com', type: 'email' }],
      'Schreib an jonas.weber@example.com.',
    );
    const surrogate = map.forward.get('jonas.weber@example.com')!;
    assert.ok(isReservedSurrogateShape(surrogate), surrogate);
  });
});
