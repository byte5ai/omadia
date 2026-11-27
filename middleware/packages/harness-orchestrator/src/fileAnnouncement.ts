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
 *  - a cue for THIS file or THIS moment inside that span: a "now" word
 *    (`jetzt`, `gleich`, `now`), an article (`die Excel`, `eine Datei`), or an
 *    addressee (`dir`) for ONE file — `dir Excel-Dateien`, `dir Excel- oder
 *    Word-Dateien` names a kind of file and reads as a capability (#2351);
 *  - no capability or condition marker before the file word (`kann`,
 *    `bei Bedarf`, `auf Wunsch`, `zuständig`, `z. B.`, `wenn`, `falls`, …): a
 *    clause after it ("…, das kann einen Moment dauern") does not cancel it.
 *    With a "now" word in the span only a condition still cancels it: `Ich
 *    helfe dir gern und erstelle jetzt die Excel` announces (#2351). A polite
 *    offer (`if you want`, `wenn du möchtest`) is no condition;
 *  - no example marker anywhere in it (`z. B.`, `unter anderem`, …);
 *  - no question.
 * English `word` is a file word only before `-` or a file noun (`Word
 * document`), never in "a word of caution".
 *
 * #2351 — a sentence that CLAIMS a file is there (`Hier ist die Excel-Datei`,
 * `Anbei die Datei`, `Here is the Excel file`) counts too: the orchestrator
 * asks only when no file was built, so the user would read about a file
 * that does not exist.
 *
 * Accepted trade-off: a build sentence without any cue ("Ich erstelle Excel-
 * und Word-Dateien.") reads as a capability, not as an announcement.
 */

/** Letter-aware word boundaries (JS `\b` treats ä, ö, ü, ß as non-word). */
const W = (body: string): string => `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`;

/** `word` only as `Word-…` or `Word document/file`, never the plain noun. */
const WORD_AS_FILE = 'word(?=-|\\s+(?:datei|dokument|file|document|docx?)(?![\\p{L}]))';
const FILE_WORD = `excel|xlsx|dateien|datei|${WORD_AS_FILE}|docx|arbeitsmappe|workbook|spreadsheet|file`;

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

/** A "now" word: the build happens in this turn. */
const NOW_CUE = new RegExp(W('jetzt|gleich|nun|sofort|direkt|now|right away'), 'iu');
/** An article: this one file. */
const ARTICLE_CUE = new RegExp(W('die|das|den|der|eine|einen|ein|the|a|an|your'), 'iu');
/** An addressee: for this user — a cue only for a single file. */
const ADDRESSEE_CUE = new RegExp(W('dir|dich|euch|ihnen|you'), 'iu');

/** Before the file word: the sentence states a condition. */
const CONDITION_MARKER = new RegExp(W('bei bedarf|auf wunsch|wenn|falls|sobald|if|on request'), 'iu');
/** Before the file word: the sentence states an ability or a condition. */
const CAPABILITY_MARKER = new RegExp(
  W('kann|kannst|können|könnte|bei bedarf|auf wunsch|zuständig|wenn|falls|sobald|bin für|helfe|can|could|if|on request'),
  'iu',
);
/** A polite offer, not a condition on the build. */
const POLITE_OFFER = new RegExp(
  W('if you (?:want|like|wish|prefer)|wenn du (?:willst|möchtest|magst)|wenn sie (?:wollen|möchten)|wenn ihr (?:wollt|möchtet)'),
  'giu',
);

/** From the file word on: a plural or a list of file kinds (`Excel- oder Word-Dateien`). */
const SEVERAL_FILES = new RegExp(
  `^[^\\n]{0,12}?(?:${W('dateien|dokumente|files|documents|workbooks|spreadsheets')}|^\\p{L}+-?\\s*${W('und|oder|and|or')}|^\\p{L}+\\s*/)`,
  'iu',
);

/** "Here is the file": a claim that a file exists. */
const CLAIM_SPAN = new RegExp(
  `${W("hier ist|hier sind|anbei|im anhang|here is|here's|here are|attached is|attached")}([^\\n,;:]{0,40}?)${W(
    '(?:excel|word)-?\\s?(?:datei|dokument|tabelle|arbeitsmappe|file|document|workbook)|xlsx|docx|datei(?!-)|dateien|arbeitsmappe|workbook|spreadsheet|file',
  )}`,
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

/**
 * Between "Hier ist" and the file word only its article and at most one
 * adjective (`die fertige Excel-Datei`, `your updated file`): "eine
 * Zusammenfassung der Datei" or "the totals from the spreadsheet" talk about
 * a file, they do not hand one over.
 */
const CLAIM_ARTICLE_ONLY = new RegExp(
  `^\\s*${W('die|das|der|den|dein|deine|ihre|eine|ein|the|a|an|your')}\\s+(?:\\p{L}+\\s+)?$`,
  'iu',
);

function claimsFile(sentence: string): boolean {
  const match = CLAIM_SPAN.exec(sentence);
  return match !== null && CLAIM_ARTICLE_ONLY.test(match[1] ?? '');
}

function announcesInSentence(sentence: string): boolean {
  if (sentence.trim().endsWith('?') || EXAMPLE_MARKER.test(sentence)) return false;
  if (claimsFile(sentence)) return true;
  for (const pattern of BUILD_SPANS) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    const span = match[1] ?? '';
    // Only what comes before and up to the file word decides: a trailing
    // clause ("…, das kann einen Moment dauern") keeps the announcement.
    const head = sentence.slice(0, match.index + match[0].length).replace(POLITE_OFFER, ' ');
    const now = NOW_CUE.test(span);
    const cancelled = now
      ? CONDITION_MARKER.test(head) || CAPABILITY_MARKER.test(span)
      : CAPABILITY_MARKER.test(head);
    if (cancelled) continue;
    if (now || ARTICLE_CUE.test(span)) return true;
    const fileWordAt = match.index + match[0].length - (match[0].match(/[\p{L}]+$/u)?.[0].length ?? 0);
    if (ADDRESSEE_CUE.test(span) && !SEVERAL_FILES.test(sentence.slice(fileWordAt))) return true;
  }
  return false;
}

/** True when some sentence of `answer` announces a file build for this turn. */
export function announcesFileBuild(answer: string): boolean {
  return sentences(answer).some(announcesInSentence);
}
