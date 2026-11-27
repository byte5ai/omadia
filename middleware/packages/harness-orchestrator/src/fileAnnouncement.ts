/**
 * Does a final answer announce a file build that this turn never made?
 *
 * The model sometimes ends a turn with "ich baue jetzt die Excel …" and stops
 * without calling `create_xlsx` / `create_docx`; the orchestrator then forces
 * one retry (`fileAnnouncedButNotBuilt`). #2345 — an agent that only LISTS
 * what it can do ("Ich beantworte Fragen und erstelle bei Bedarf Excel- und
 * Word-Dateien") was read as an announcement, and the forced retry made it
 * "correct" an announcement it never made.
 *
 * Per sentence, an announcement is a build phrase that reaches a file word
 * (German present `ich erstelle … die Excel`, German future `ich werde … die
 * Excel-Datei erstellen`, English `I'll create the Excel file`) with:
 *  - a cue for THIS file or THIS moment inside that span: an article, an
 *    addressee or a "now" word (`die Excel`, `dir eine Datei`, `jetzt`);
 *  - no capability or condition marker before the file word (`kann`,
 *    `bei Bedarf`, `auf Wunsch`, `zuständig`, `z. B.`, `wenn`, `falls`, …): a
 *    clause after it ("…, das kann einen Moment dauern") does not cancel it;
 *  - no example marker anywhere in it (`z. B.`, `unter anderem`, …);
 *  - no question.
 * Accepted trade-off: a build sentence without any cue ("Ich erstelle Excel-
 * und Word-Dateien.") reads as a capability, not as an announcement.
 */

/** Letter-aware word boundaries (JS `\b` treats ä, ö, ü, ß as non-word). */
const W = (body: string): string => `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`;

const FILE_WORD = 'excel|xlsx|dateien|datei|word|docx|arbeitsmappe|workbook|spreadsheet|file';

/** The build phrase up to its file word; group 1 is the span between them. */
const BUILD_SPANS: readonly RegExp[] = [
  // German present, first person: "ich erstelle (jetzt die) Excel …".
  new RegExp(`${W('baue|erstelle|erzeuge|generiere|exportiere')}([^\\n]{0,100}?)${W(FILE_WORD)}`, 'iu'),
  // German future: "ich werde (jetzt die) Excel-Datei erstellen".
  new RegExp(
    `${W('werde')}([^\\n]{0,100}?)${W(FILE_WORD)}[^\\n]{0,40}?${W('erstellen|bauen|erzeugen|generieren|exportieren')}`,
    'iu',
  ),
  // English: "I'll / I will / I'm going to / let me create (the) Excel file", "creating the xlsx now".
  new RegExp(
    `(?:${W("i'll|i will|i'm going to|i am going to|let me")}[^\\n]{0,20}?${W('create|build|generate|export|make')}|${W('creating|building|generating|exporting')})([^\\n]{0,100}?)${W(FILE_WORD)}`,
    'iu',
  ),
];

/** An article, an addressee or a "now" word: this file, for this user, now. */
const SPECIFIC_CUE = new RegExp(
  W('jetzt|gleich|nun|sofort|direkt|dir|dich|euch|ihnen|die|das|den|der|eine|einen|ein|now|the|a|an|you|your'),
  'iu',
);

/** Before the file word: the sentence states an ability or a condition. */
const CAPABILITY_MARKER = new RegExp(
  W('kann|kannst|können|könnte|bei bedarf|auf wunsch|zuständig|wenn|falls|sobald|bin für|helfe|can|could|if|on request'),
  'iu',
);

/** Anywhere in the sentence: the file words are examples in a list. */
const EXAMPLE_MARKER = new RegExp(W('zum beispiel|zB|beispielsweise|unter anderem|uA|for example|eg|such as'), 'iu');

/** Abbreviations whose dots would end a sentence, folded to dot-free tokens. */
const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![\p{L}])z\.\s?b\./giu, 'zB'],
  [/(?<![\p{L}])d\.\s?h\./giu, 'dh'],
  [/(?<![\p{L}])u\.\s?a\./giu, 'uA'],
  [/(?<![\p{L}])e\.\s?g\./giu, 'eg'],
  [/(?<![\p{L}])i\.\s?e\./giu, 'ie'],
  [/(?<![\p{L}])(ca|bzw|nr|vgl|ggf|usw|evtl|inkl|ggü|etc)\./giu, '$1'],
];

function sentences(answer: string): string[] {
  let text = answer.normalize('NFC');
  for (const [pattern, token] of ABBREVIATIONS) text = text.replace(pattern, token);
  // A period after a digit ("27. November", "1.234") ends no sentence.
  return text.split(/(?<=[.!?])(?<!\d\.)\s+|\n+/u).filter((s) => s.trim().length > 0);
}

function announcesInSentence(sentence: string): boolean {
  if (sentence.trim().endsWith('?') || EXAMPLE_MARKER.test(sentence)) return false;
  for (const pattern of BUILD_SPANS) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    // Only what comes before and up to the file word decides: a trailing
    // clause ("…, das kann einen Moment dauern") keeps the announcement.
    const head = sentence.slice(0, match.index + match[0].length);
    if (CAPABILITY_MARKER.test(head)) continue;
    if (SPECIFIC_CUE.test(match[1] ?? '')) return true;
  }
  return false;
}

/** True when some sentence of `answer` announces a file build for this turn. */
export function announcesFileBuild(answer: string): boolean {
  return sentences(answer).some(announcesInSentence);
}
