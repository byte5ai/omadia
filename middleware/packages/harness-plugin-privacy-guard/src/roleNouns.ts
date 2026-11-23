/**
 * Generic role nouns are not person names.
 *
 * C1 (GLiNER) tags lone role nouns as `person`: "User", "Kunde", "Admin", at
 * scores up to 0.99 (live). A tagged role noun becomes a real value in the
 * turn's pseudonym map, and from there every later echo of the word is
 * rewritten: on Fly a tool result read "rendered server-side for the lukas
 * becker", where it had said "for the user".
 *
 * A `person` span is dropped only when EVERY word in it is a role noun or a
 * determiner ("the user", "der Kunde", "Admin"). A span with any other word in
 * it ("Kunde Müller", "Admin Jonas Weber") is kept whole, so a real name next
 * to a role noun is still masked.
 */

/** Role nouns, lower case, base forms. Inflections come from {@link SUFFIXES}. */
const ROLE_BASES: readonly string[] = [
  // English
  'user', 'customer', 'client', 'admin', 'administrator', 'operator', 'owner',
  'manager', 'employee', 'colleague', 'assistant', 'agent', 'bot', 'guest',
  'member', 'person', 'people', 'someone', 'somebody', 'anyone', 'anybody',
  'everyone', 'nobody', 'human', 'staff', 'team', 'support', 'sender',
  'recipient', 'author', 'reviewer', 'requester', 'requestor', 'approver',
  'contact', 'supplier', 'vendor', 'partner', 'candidate', 'applicant',
  'participant', 'attendee', 'organizer', 'organiser', 'moderator',
  'facilitator', 'host', 'boss', 'lead', 'supervisor', 'developer',
  'maintainer', 'tenant', 'account', 'caller', 'visitor', 'buyer', 'seller',
  'student', 'teacher', 'patient', 'subscriber', 'superuser', 'root',
  // German
  'benutzer', 'nutzer', 'anwender', 'kunde', 'kundin', 'betreiber',
  'bediener', 'mitarbeiter', 'mitarbeitende', 'mitarbeitender', 'kollege',
  'kollegin', 'chef', 'inhaber', 'vorgesetzte', 'vorgesetzter',
  'ansprechpartner', 'ansprechperson', 'lieferant', 'bewerber', 'teilnehmer',
  'teilnehmende', 'gast', 'gäste', 'absender', 'empfänger', 'autor',
  'verfasser', 'antragsteller', 'sachbearbeiter', 'geschäftsführer',
  'geschäftsführung', 'assistent', 'leiter', 'leitung', 'personen', 'mensch',
  'jemand', 'niemand', 'besucher', 'käufer', 'verkäufer', 'auftraggeber',
  'dienstleister', 'entwickler', 'mandant',
];

/** Plural and feminine endings accepted on every base. */
const SUFFIXES: readonly string[] = ['', 's', 'n', 'en', 'in', 'innen', 'es'];

/** Articles, demonstratives and possessives that may stand in such a span. */
const DETERMINERS: readonly string[] = [
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'our', 'your', 'my',
  'their', 'his', 'her', 'its', 'any', 'each', 'every', 'some',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',
  'einer', 'eines', 'unser', 'unsere', 'unseren', 'unserem', 'unserer', 'ihr',
  'ihre', 'ihren', 'ihrem', 'ihrer', 'mein', 'meine', 'meinen', 'meinem',
  'meiner', 'dein', 'deine', 'deinen', 'deinem', 'deiner', 'jeder', 'jede',
  'jeden', 'jedem',
];

const ROLE_WORDS: ReadonlySet<string> = new Set(
  ROLE_BASES.flatMap((base) => SUFFIXES.map((suffix) => base + suffix)),
);
const FILLER_WORDS: ReadonlySet<string> = new Set(DETERMINERS);

const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * True when `spanText` names no one in particular: it has at least one role
 * noun, and every word in it is a role noun or a determiner. Compared without
 * case, so "USER", "User" and "user" are all the same role noun.
 */
export function isRoleNounOnly(spanText: string): boolean {
  const words = spanText.toLowerCase().match(WORD_RUN) ?? [];
  if (words.length === 0) return false;
  let hasRole = false;
  for (const word of words) {
    if (ROLE_WORDS.has(word)) {
      hasRole = true;
      continue;
    }
    if (!FILLER_WORDS.has(word)) return false;
  }
  return hasRole;
}
