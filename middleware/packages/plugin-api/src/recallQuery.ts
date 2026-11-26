/**
 * Full-text recall query (#1822).
 *
 * Recall searches stored turns and processes with the user's message. Handing
 * the whole message to `plainto_tsquery` joins every word with AND, so a stored
 * turn matched only when it contained every word of the question, including
 * "wann", "der" and "seine". A short "ok" did the opposite and pulled any turn
 * that contained it.
 *
 * This module turns a free-text message into the content terms recall searches
 * for, and into an OR `tsquery` over them. Both knowledge-graph backends use it,
 * so the lexical leg behaves the same with and without Postgres. A message
 * without content terms yields no query at all: no lexical recall.
 */

/** At most this many terms go into one query. */
export const RECALL_QUERY_MAX_TERMS = 16;

/** Shortest kept term without a digit. Digit terms ("p11", "42") need 2. */
const MIN_TERM_LENGTH = 3;
const MIN_DIGIT_TERM_LENGTH = 2;

// Function words and filler in German and English. They carry no topic, so
// matching on them only adds noise. Lowercase, compared after lowercasing.
const RECALL_STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'from', 'have',
  'has', 'had', 'was', 'were', 'are', 'is', 'be', 'been', 'being', 'you', 'your',
  'yours', 'our', 'ours', 'his', 'her', 'its', 'their', 'they', 'them', 'she',
  'him', 'who', 'whom', 'what', 'when', 'where', 'which', 'why', 'how', 'can',
  'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'does',
  'did', 'done', 'not', 'any', 'all', 'some', 'about', 'into', 'onto', 'over',
  'than', 'then', 'there', 'here', 'also', 'just', 'only', 'very', 'please',
  'thanks', 'thank', 'okay', 'yes', 'yeah', 'hello', 'hey', 'tell', 'know',
  'get', 'got', 'let', 'want',
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',
  'einer', 'eines', 'und', 'oder', 'aber', 'ist', 'sind', 'war', 'waren', 'bin',
  'bist', 'sein', 'seine', 'seinen', 'seinem', 'seiner', 'ihre', 'ihren', 'ihrem',
  'ihrer', 'mein', 'meine', 'meinen', 'meinem', 'meiner', 'dein', 'deine',
  'deinen', 'deinem', 'deiner', 'unser', 'unsere', 'euer', 'eure', 'mit', 'für',
  'von', 'vom', 'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'über', 'unter',
  'vor', 'durch', 'gegen', 'ohne', 'um', 'ich', 'mir', 'mich', 'dich', 'dir',
  'wir', 'uns', 'ihr', 'euch', 'sie', 'ihm', 'ihn', 'man', 'was', 'wer', 'wen',
  'wem', 'wie', 'wo', 'wann', 'warum', 'wieso', 'weshalb', 'welche', 'welcher',
  'welches', 'welchen', 'welchem', 'nicht', 'kein', 'keine', 'keinen', 'noch',
  'schon', 'auch', 'nur', 'sehr', 'dass', 'wenn', 'als', 'wird', 'werden',
  'wurde', 'wurden', 'hat', 'habe', 'haben', 'hast', 'hatte', 'kann', 'kannst',
  'können', 'soll', 'sollte', 'muss', 'mal', 'denn', 'doch', 'gibt', 'bitte',
  'danke', 'hallo', 'okay', 'ja', 'nein', 'genau', 'gut', 'alles', 'etwas',
  'dazu', 'davon', 'darüber', 'hier', 'dort', 'jetzt', 'weißt', 'weiß', 'sag',
  'sage', 'zeig', 'zeige', 'gib',
]);

/**
 * The content terms of a message as the `simple` text-search parser sees them:
 * lowercase runs of letters and digits, split at every other character (so
 * "Sicherheits-Patches" gives "sicherheits" and "patches"). Stop words and
 * very short tokens are dropped, duplicates removed, capped at
 * {@link RECALL_QUERY_MAX_TERMS}. Every term matches `^[\p{L}\p{N}]+$`.
 */
export function extractRecallSearchTerms(message: string): string[] {
  const tokens = message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    const hasDigit = /\p{N}/u.test(token);
    const minLength = hasDigit ? MIN_DIGIT_TERM_LENGTH : MIN_TERM_LENGTH;
    if (token.length < minLength) continue;
    if (!hasDigit && RECALL_STOPWORDS.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= RECALL_QUERY_MAX_TERMS) break;
  }
  return out;
}

/**
 * An OR query over the message's content terms, for
 * `to_tsquery('simple', …)`, or `null` when the message has no content term.
 * Terms hold only letters and digits, so the string carries no tsquery
 * operator a user could inject.
 */
export function buildRecallTsQuery(message: string): string | null {
  const terms = extractRecallSearchTerms(message);
  return terms.length === 0 ? null : terms.join(' | ');
}
