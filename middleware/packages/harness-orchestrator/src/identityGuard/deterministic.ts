/**
 * Identity guard, deterministic layer (#2046, spec 2042 INV-3, §5.5).
 *
 * Checks an agent's `prose` against the directory of agent names and aliases:
 *  - a claim to be human ("I am a person", "ich bin kein Bot");
 *  - the agent naming itself as another agent ("I'm the Strategist");
 *  - an attributed quote or paraphrase of another agent ("Mira says",
 *    "laut Mira"). A colleague's words reach people only as that colleague's
 *    own delivered contribution, which the agent's text refers to by id; free
 *    text attributed to a colleague is refused, also after a real
 *    consultation.
 *
 * A plain mention passes ("Mira can help with that"). Text that mentions a
 * colleague or introduces someone is marked `suspicious`, so the model layer
 * looks at it; everything else passes without a model call.
 *
 * Coverage is defined by tests; this is a strong guard, not a proof.
 */

export interface GuardDirectoryEntry {
  readonly agentId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly aliases?: readonly string[];
}

export interface GuardSelf {
  readonly agentId: string;
  readonly slug: string;
  readonly displayName: string;
}

export type IdentityGuardRule =
  | 'human_claim'
  | 'other_agent_identity'
  | 'attributed_quote';

export type DeterministicVerdict =
  | {
      readonly verdict: 'pass';
      /** True when the model layer must look at the text. */
      readonly suspicious: boolean;
      /** Colleagues the text mentions (display names). */
      readonly mentions: readonly string[];
    }
  | {
      readonly verdict: 'block';
      readonly rule: IdentityGuardRule;
      /** The colleague the text claims to be or quotes. */
      readonly agent?: string;
    };

/** Shorter names match ordinary words too often to be a signal on their own. */
const MIN_NAME_LENGTH = 3;

const ARTICLE = String.raw`(?:(?:the|your|a|der|die|das|dein|deine|ihr|ihre|euer|eure)\s+)?`;

const SELF_IDENTIFICATION_PREFIXES = [
  String.raw`i\s*am`,
  String.raw`i['’]m`,
  String.raw`this\s+is`,
  String.raw`my\s+name\s+is`,
  String.raw`call\s+me`,
  String.raw`speaking\s+as`,
  String.raw`answering\s+as`,
  String.raw`you(?:['’]re|\s+are)\s+(?:talking|speaking|chatting|writing)\s+(?:to|with)`,
  String.raw`ich\s+bin`,
  String.raw`hier\s+(?:ist|spricht|schreibt)`,
  String.raw`mein\s+name\s+ist`,
  String.raw`ich\s+hei(?:ß|ss)e`,
  String.raw`(?:du|sie)\s+(?:sprichst|sprechen|schreibst|schreiben|chattest|chatten)\s+(?:gerade\s+)?mit`,
  String.raw`ich\s+(?:antworte|spreche)\s+(?:hier\s+)?als`,
];

const QUOTE_VERBS_AFTER = [
  // English
  'says', 'said', 'thinks', 'thought', 'believes', 'believed', 'recommends',
  'recommended', 'suggests', 'suggested', 'told me', 'tells me', 'told us',
  'answered', 'replied', 'responded', 'writes', 'wrote', 'mentioned',
  'notes', 'noted', 'claims', 'claimed', 'states', 'stated', 'explains',
  'explained', 'confirms', 'confirmed', 'advises', 'advised', 'feels',
  'would say', 'agrees', 'agreed', 'insists', 'argues', 'argued',
  // German
  'sagt', 'sagte', 'meint', 'meinte', 'denkt', 'dachte', 'findet', 'fand',
  'empfiehlt', 'empfahl', 'schlägt vor', 'schlug vor', 'hat gesagt',
  'hat geantwortet', 'hat gemeint', 'hat empfohlen', 'antwortet',
  'antwortete', 'schreibt', 'schrieb', 'erklärt', 'erklärte', 'bestätigt',
  'bestätigte', 'betont', 'betonte', 'rät', 'riet', 'hält', 'würde sagen',
  'ist der meinung', 'ist der ansicht', 'stimmt zu', 'hat bestätigt',
];

const QUOTE_PREFIXES_BEFORE = [
  String.raw`according\s+to`,
  String.raw`as\s+per`,
  String.raw`in\s+the\s+words\s+of`,
  String.raw`quoting`,
  String.raw`citing`,
  String.raw`as\s+(?:told|said|explained)\s+by`,
  String.raw`laut`,
  String.raw`gem(?:ä|ae)(?:ß|ss)`,
  String.raw`nach\s+(?:aussage|ansicht|meinung|einsch(?:ä|ae)tzung|auskunft)\s+(?:von)?`,
  String.raw`zitat\s+(?:von)?`,
];

const OPINION_NOUNS = [
  'answer', 'response', 'reply', 'view', 'opinion', 'assessment',
  'recommendation', 'statement', 'words', 'take', 'advice', 'verdict',
  'antwort', 'einschätzung', 'meinung', 'empfehlung', 'aussage', 'sicht',
  'ansicht', 'rat', 'urteil', 'worte',
];

const HUMAN_CLAIMS: readonly RegExp[] = [
  // "I am a (real) human / person", "I'm human"
  /\b(?:i\s*am|i['’]m)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|living\s+)?(?:human(?:\s+being)?|person|man|woman|flesh\s+and\s+blood)\b/iu,
  // "I am not a bot / an AI"
  /\b(?:i\s*am|i['’]m)\b[^.!?\n]{0,80}?\bnot\s+(?:a|an)\s+(?:bot|ai|a\.i\.|robot|machine|program|language\s+model|chatbot)\b/iu,
  /\b(?:i\s*am|i['’]m)\b[^.!?\n]{0,80}?\bno\s+(?:bot|robot|machine|ai)\b/iu,
  /\bnot\s+an?\s+(?:ai|bot|chatbot)\s*[,;—–-]\s*(?:i\s*am|i['’]m)\s+(?:a\s+)?(?:real\s+)?(?:human|person)\b/iu,
  // "ich bin ein (echter) Mensch / eine echte Person"
  /\bich\s+bin\s+(?:ein\s+|eine\s+)?(?:echter\s+|echte\s+|richtiger\s+|richtige\s+|lebendiger\s+)?(?:mensch|person|mitarbeiter(?:in)?\s+aus\s+fleisch\s+und\s+blut)\b/iu,
  // "ich bin (Anna aus dem Vertrieb,) kein Bot / keine KI / nicht ein Bot"
  /\bich\s+bin\b[^.!?\n]{0,80}?\b(?:kein|keine|nicht\s+(?:ein|eine))\s+(?:bot|ki|k\.i\.|ai|roboter|maschine|programm|sprachmodell|chatbot|künstliche\s+intelligenz)\b/iu,
  /\b(?:aus\s+fleisch\s+und\s+blut|flesh\s+and\s+blood)\b/iu,
];

const SELF_INTRODUCTION: readonly RegExp[] = [
  /\b(?:my\s+name\s+is|call\s+me|this\s+is|mein\s+name\s+ist|ich\s+hei(?:ß|ss)e|hier\s+(?:ist|spricht|schreibt))\s+\p{Lu}/u,
  /\b(?:i['’]m|i\s+am|ich\s+bin)\s+\p{Lu}\p{Ll}+(?:\s+(?:from|aus|vom|von|der|die))?\b/u,
  /\b(?:human|person|mensch|bot|robot|roboter|künstliche\s+intelligenz)\b/iu,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A name as a pattern: whitespace and dashes in it match any run of them. */
function namePattern(name: string): string {
  return escapeRegExp(name.trim()).replace(/(?:\\-|\s)+/g, String.raw`[\s\-_]+`);
}

interface NamedPatterns {
  readonly displayName: string;
  readonly mention: RegExp;
  readonly selfIdentification: RegExp;
  readonly quote: readonly RegExp[];
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function namesOf(entry: GuardDirectoryEntry): string[] {
  return [entry.displayName, entry.slug, ...(entry.aliases ?? [])]
    .map((name) => name.trim())
    .filter((name) => name.length >= MIN_NAME_LENGTH);
}

function compileFor(entry: GuardDirectoryEntry, ownNames: ReadonlySet<string>): NamedPatterns | null {
  const names = namesOf(entry).filter((name) => !ownNames.has(normalizeName(name)));
  if (names.length === 0) return null;
  const alternation = names.map(namePattern).join('|');
  const name = String.raw`(?:${alternation})`;
  // Unicode-aware word boundaries: a name must not be part of a longer word.
  const before = String.raw`(?<![\p{L}\p{N}_])`;
  const after = String.raw`(?![\p{L}\p{N}_])`;
  const named = `${before}${name}${after}`;
  const possessive = `${before}${name}(?:['’]s|s)?${after}`;
  return {
    displayName: entry.displayName,
    mention: new RegExp(possessive, 'iu'),
    selfIdentification: new RegExp(
      // "I'm Mira's colleague" is no claim to be Mira.
      String.raw`\b(?:${SELF_IDENTIFICATION_PREFIXES.join('|')})\s+${ARTICLE}${named}(?!['’]s?(?![\p{L}]))`,
      'iu',
    ),
    quote: [
      new RegExp(String.raw`${named}\s+(?:${QUOTE_VERBS_AFTER.map(escapeRegExp).join('|')})(?![\p{L}])`, 'iu'),
      new RegExp(String.raw`\b(?:${QUOTE_PREFIXES_BEFORE.join('|')})\s*${ARTICLE}${named}`, 'iu'),
      new RegExp(String.raw`${possessive}\s+(?:${OPINION_NOUNS.join('|')})\b`, 'iu'),
      new RegExp(String.raw`${named}\s+(?:zufolge|nach)\b`, 'iu'),
      // A name line: "Mira: …" at the start of a line or sentence, the way a
      // transcript or a chat attributes a message.
      new RegExp(String.raw`(?:^|\n|[.!?…]\s+)\s*(?:\*\*)?${named}(?:\*\*)?\s*:`, 'iu'),
    ],
  };
}

/** Compiled directory for one speaker; build once per turn. */
export class IdentityGuardPatterns {
  private readonly colleagues: readonly NamedPatterns[];

  constructor(self: GuardSelf, directory: readonly GuardDirectoryEntry[]) {
    const ownEntry = directory.find((entry) => entry.agentId === self.agentId);
    const ownNames = new Set(
      [self.displayName, self.slug, ...(ownEntry?.aliases ?? [])].map(normalizeName),
    );
    this.colleagues = directory
      .filter((entry) => entry.agentId !== self.agentId)
      .map((entry) => compileFor(entry, ownNames))
      .filter((patterns): patterns is NamedPatterns => patterns !== null);
  }

  check(text: string): DeterministicVerdict {
    for (const claim of HUMAN_CLAIMS) {
      if (claim.test(text)) return { verdict: 'block', rule: 'human_claim' };
    }
    const mentions: string[] = [];
    for (const colleague of this.colleagues) {
      if (!colleague.mention.test(text)) continue;
      if (colleague.selfIdentification.test(text)) {
        return { verdict: 'block', rule: 'other_agent_identity', agent: colleague.displayName };
      }
      if (colleague.quote.some((pattern) => pattern.test(text))) {
        return { verdict: 'block', rule: 'attributed_quote', agent: colleague.displayName };
      }
      mentions.push(colleague.displayName);
    }
    const introduces = SELF_INTRODUCTION.some((pattern) => pattern.test(text));
    return { verdict: 'pass', suspicious: mentions.length > 0 || introduces, mentions };
  }
}

export function checkIdentityDeterministic(
  text: string,
  self: GuardSelf,
  directory: readonly GuardDirectoryEntry[],
): DeterministicVerdict {
  return new IdentityGuardPatterns(self, directory).check(text);
}
