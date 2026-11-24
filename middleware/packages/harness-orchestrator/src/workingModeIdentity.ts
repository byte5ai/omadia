/**
 * #2060 — a working mode never replaces who answers (spec 2043 §2.3, AVE §5.2).
 *
 * An agent of an archetype other than `standard` (today: the facilitator) has
 * a fixed identity: its name, its channel identity and, for the facilitator,
 * the neutrality contract. A working mode may change HOW it works (a
 * moderation method, a format), never WHO speaks. {@link withWorkingMode}
 * already composes every mode beneath the identity with a precedence line;
 * this check refuses, at attach time and again when the agent is built, a
 * mode that is written as an identity of its own: a new name, a persona,
 * speaking as somebody else.
 *
 * Deterministic and literal on purpose, like the instruction check of the
 * neutrality contract: the operator gets the same answer for the same text
 * and sees the sentence it objects to. It is not the only guard. A paraphrase
 * that slips through still lands beneath the identity and its precedence line.
 */

export interface WorkingModeText {
  readonly name: string;
  readonly description: string | null;
  readonly body: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

export interface WorkingModeIdentityFinding {
  /** `working_mode.body`, `working_mode.description` or `working_mode.frontmatter.<key>`. */
  readonly path: string;
  readonly rule: 'identity_replacement';
  readonly message: string;
  readonly excerpt?: string;
}

/** Frontmatter keys that declare who speaks. A mode has none of them. */
const IDENTITY_FRONTMATTER_KEYS: readonly string[] = [
  'persona',
  'identity',
  'speaker',
  'display_name',
  'displayName',
  'agent_name',
  'agentName',
  'avatar',
];

interface IdentityRule {
  readonly message: string;
  readonly pattern: RegExp;
}

// A moderation method may name the facilitator's own role ("you are the
// facilitator of this retro", "introduce yourself as the moderator"); that is
// not a different identity.
const OWN_ROLE = String.raw`(?:(?:a|an|the|this|der|die|ein|eine|kurz)\s+)?(?:neutral\w*\s+)?(?:facilitator\w*|moderat\w*|timekeeper|zeitwächter\w*|zeitnehmer\w*)\b`;

// A rule about speaking as someone counts only where the AGENT is addressed:
// at the start of a sentence (an imperative) or after "you"/"du". "In
// role-play exercises, participants pretend to be customers" describes a
// method for the group and passes.
const TO_AGENT = String.raw`(?:^|[.!?:;]\s+|\n\s*(?:[-*]\s+)?|\byou\s+(?:should\s+|must\s+|will\s+|may\s+|are\s+to\s+)?|\bdu\s+(?:sollst\s+|wirst\s+|musst\s+)?)`;

// Somebody the agent could be made to speak as.
const SOMEBODY = String.raw`(?:someone|somebody|another (?:person|agent|bot)|a different (?:person|agent|bot)|the (?:user|initiator|manager|ceo|boss|team lead|sales (?:team|lead)|customer)|(?:a|an) (?:sales (?:manager|rep\w*)|customer|participant|manager))`;

// Capitalised words after "as" that are formats, not names.
const FORMAT_WORDS = '(?:A|An|The|Facilitator|Moderator|Markdown|Json|JSON|Bullet|Bullets|Table|List|One|Text|Prose|Html|HTML|Csv|CSV|Yaml|YAML|Plain|Short|Summary)';

const IDENTITY_RULES: readonly IdentityRule[] = [
  {
    message: 'gives the agent another name',
    pattern: new RegExp(
      String.raw`\b(?:your (?:new )?name is|you are (?:called|named)|call yourself|introduce yourself as(?! ${OWN_ROLE})|sign (?:your messages |every message |off )?as|dein (?:neuer )?name ist|du hei(?:ß|ss)t|nenne? dich(?! ${OWN_ROLE})|stell\w* dich (?:\w+ ){0,2}als(?! ${OWN_ROLE})|unterschreib\w* (?:\w+ ){0,2}als)\b`,
      'iu',
    ),
  },
  {
    message: 'makes the agent speak as somebody else',
    pattern: new RegExp(
      String.raw`${TO_AGENT}(?:(?:speak|answer|respond|reply|talk|write|post)(?:s|ing)? (?:in the name of|on behalf of)(?! yourself\b| ${OWN_ROLE})|(?:speak|answer|respond|reply|talk)(?:s|ing)? as (?:if you were|though you were|${SOMEBODY})|(?:act|pose) as ${SOMEBODY}|pretend (?:to be|you are)|claim to be (?!neutral|impartial)|impersonat\w*|role-?play(?:ing)? as|play the role of|adopt the (?:persona|role|voice) of|(?:antworte|sprich|schreib\w*|poste)\w* (?:im namen von|als ob du|als wärst du|als jemand)|gib dich (?:\w+ ){0,2}als|schlüpf\w* in die rolle)`,
      'imu',
    ),
  },
  {
    message: 'makes the agent speak as somebody else',
    pattern: new RegExp(String.raw`\b(?:in the voice of|im namen von) (?:the |a |an )?(?:ceo|initiator|manager|boss|customer|sales\w*|\p{Lu}\p{Ll}+)`, 'iu'),
  },
  {
    message: 'replaces the agent’s identity',
    pattern: new RegExp(
      String.raw`\b(?:(?:you are now|from now on,? you are|you are no longer|du bist (?:jetzt|ab jetzt|nun|ab sofort|nicht mehr)) (?:the |a |an |der |die |das |ein |eine )(?!${OWN_ROLE})|forget (?:who|what) you are|your (?:new )?(?:identity|persona|character) is|vergiss,? wer du bist|deine (?:neue )?(?:identität|persona) ist)`,
      'iu',
    ),
  },
  {
    // "Answer as Mira": a name after "as". Case-sensitive: the capital is
    // what tells a name from "answer as bullet points".
    message: 'makes the agent speak as somebody else',
    pattern: new RegExp(
      String.raw`\b(?:[Ss]peak|[Aa]nswer|[Rr]espond|[Rr]eply|[Tt]alk|[Aa]ct|[Bb]ecome)(?:s|ing)? as (?!${FORMAT_WORDS}\b)\p{Lu}\p{Ll}+\b|(?:^|[.!?]\s+)Become (?!${FORMAT_WORDS}\b)\p{Lu}\p{Ll}+[.!]`,
      'mu',
    ),
  },
  {
    // "You are Mira." / "Du bist Mira." / "You are now Max.": a proper name
    // right after it, followed by punctuation or an apposition.
    message: 'gives the agent another name',
    pattern: new RegExp(
      String.raw`\b(?:You are|Du bist)(?: now| jetzt| nun)? (?!(?:A|An|The|Now|Not|No|In|At|On|Here|There|Facilitator|Moderator|Moderatorin|Zeitwächter\p{Ll}*|Responsible|Welcome|Ready)\b)\p{Lu}\p{Ll}+(?:\s\p{Lu}\p{Ll}+)?(?=[,.!:;]|\s(?:and|the|a|an)\b)`,
      'u',
    ),
  },
];

const EXCERPT_RADIUS = 40;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function scan(text: string | null, path: string): WorkingModeIdentityFinding[] {
  const source = text?.trim() ?? '';
  if (source.length === 0) return [];
  const findings: WorkingModeIdentityFinding[] = [];
  const seen = new Set<string>();
  for (const rule of IDENTITY_RULES) {
    if (seen.has(rule.message)) continue;
    const match = rule.pattern.exec(source);
    if (!match) continue;
    seen.add(rule.message);
    findings.push({
      path,
      rule: 'identity_replacement',
      message: `a working mode changes how the agent works, never who speaks: it ${rule.message}`,
      excerpt: excerptAround(source, match.index, match[0].length),
    });
  }
  return findings;
}

/**
 * Every place where the mode is written as an identity of its own. Empty =
 * the mode only changes how the agent works.
 */
export function findWorkingModeIdentityReplacement(
  mode: WorkingModeText,
): readonly WorkingModeIdentityFinding[] {
  const fromFrontmatter: WorkingModeIdentityFinding[] = IDENTITY_FRONTMATTER_KEYS.filter(
    (key) => mode.frontmatter?.[key] !== undefined && mode.frontmatter[key] !== null,
  ).map((key) => ({
    path: `working_mode.frontmatter.${key}`,
    rule: 'identity_replacement',
    message: `a working mode changes how the agent works, never who speaks: it declares '${key}'`,
  }));
  return [
    ...fromFrontmatter,
    ...scan(mode.description, 'working_mode.description'),
    ...scan(mode.body, 'working_mode.body'),
  ];
}
