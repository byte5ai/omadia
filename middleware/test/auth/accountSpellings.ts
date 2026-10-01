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
  'i̇iii@example.com',
  'ασ@example.com',
  'élise@example.com',
  'finance@example.com',
  'kelvin@example.com',
  'straße@example.com',
  'ǆana@example.com',
  'ωθς@example.com',
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
    s.replace(/i/g, 'İ'),
    s.toUpperCase().replace(/I/g, 'İ'),
    s.replace(/i/g, 'ı'),
    s.normalize('NFD'),
    s.normalize('NFC'),
    s.replace(/fi/g, 'ﬁ'),
    s.replace(/k/g, 'K'),
    s.replace(/σ/g, 'ς').replace(/θ/g, 'ϴ'),
    s.replace(/ß/g, 'ẞ'),
    s.replace(/ǆ/g, 'ǅ'),
    fullwidth(s),
    ` ${s.toUpperCase()} `,
  ];
}

export function accountSpellings(): string[] {
  return [...new Set(BASES.flatMap(forms))];
}
