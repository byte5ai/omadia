/**
 * Spellings of a handful of sign-in addresses, in every form a sign-in could
 * type them: case, the Turkish dotted and dotless i, a combining dot, word-final
 * and lunate sigma, decomposed and precomposed accents, compatibility forms
 * (fullwidth letters, a ligature, the Kelvin sign), the capital sharp s, a
 * titlecase digraph and surrounding whitespace. Shared by loginAccount.test.ts
 * (LOWER() as collations apply it, simulated) and
 * loginAccountFold.pg.test.ts (real Postgres).
 */

const BASES = [
  'admin@example.com',
  'iiii@example.com',
  'i\u0307iii@example.com',
  '\u03b1\u03c3@example.com',
  '\u00e9lise@example.com',
  'finance@example.com',
  'kelvin@example.com',
  'stra\u00dfe@example.com',
  '\u01c6ana@example.com',
  '\u03c9\u03b8\u03c2@example.com',
] as const;

/** 'a'..'z' as fullwidth letters. */
function fullwidth(s: string): string {
  return Array.from(s, (c) =>
    c >= 'a' && c <= 'z' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c,
  ).join('');
}

function forms(s: string): string[] {
  return [
    s,
    s.toUpperCase(),
    s.replace(/i/g, '\u0130'),
    s.toUpperCase().replace(/I/g, '\u0130'),
    s.replace(/i/g, '\u0131'),
    s.normalize('NFD'),
    s.normalize('NFC'),
    s.replace(/fi/g, '\ufb01'),
    s.replace(/k/g, '\u212a'),
    s.replace(/\u03c3/g, '\u03c2').replace(/\u03b8/g, '\u03f4'),
    s.replace(/\u00df/g, '\u1e9e'),
    s.replace(/\u01c6/g, '\u01c5'),
    fullwidth(s),
    ` ${s.toUpperCase()} `,
  ];
}

export function accountSpellings(): string[] {
  return [...new Set(BASES.flatMap(forms))];
}
