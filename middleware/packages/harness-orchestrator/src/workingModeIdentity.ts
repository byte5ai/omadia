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
// facilitator of this retro"); that is not a different identity.
const OWN_ROLE = String.raw`(?:(?:a|an|the|this|der|die|ein|eine)\s+)?(?:neutral\w*\s+)?(?:facilitator\w*|moderat\w*|timekeeper|zeitwächter\w*)`;

const IDENTITY_RULES: readonly IdentityRule[] = [
  {
    message: 'gives the agent another name',
    pattern:
      /\b(?:your (?:new )?name is|you are (?:called|named)|call yourself|introduce yourself as|sign (?:off |your messages |every message )?(?:as|with)|dein (?:neuer )?name ist|du hei(?:ß|ss)t|nenne? dich|stell\w* dich (?:\w+ ){0,2}als|unterschreib\w* (?:\w+ ){0,2}(?:als|mit))\b/i,
  },
  {
    message: 'makes the agent speak as somebody else',
    // "Answer as a table" is a format, not a speaker: only "as" followed by
    // somebody (a name, "someone", "the initiator") counts.
    pattern: new RegExp(
      String.raw`\b(?:(?:speak|answer|respond|reply|write|talk|post)(?:s|ing)? (?:in the name of|on behalf of)(?! yourself\b| ${OWN_ROLE}\b)|(?:speak|answer|respond|reply|talk)(?:s|ing)? as (?:if you were|though you were|someone|somebody|another (?:person|agent|bot)|a different (?:person|agent|bot)|the (?:user|initiator|manager|ceo|boss|team lead))|pretend (?:to be|you are)|claim to be|impersonat\w*|role-?play(?:ing)? as|(?:antworte|sprich|schreib\w*|poste)\w* (?:im namen von|als ob du|als wärst du|als jemand)|gib dich (?:\w+ ){0,2}als|schlüpf\w* in die rolle|in die rolle (?:von|des|der|eines|einer) )`,
      'i',
    ),
  },
  {
    message: 'replaces the agent’s identity',
    pattern:
      /\b(?:you are now(?! in\b)|from now on,? you are|you are no longer|forget (?:who|what) you are|your (?:new )?(?:identity|persona|character) is|du bist (?:jetzt|ab jetzt|nun|ab sofort)(?! in\b| im\b)|du bist nicht mehr|vergiss,? wer du bist|deine (?:neue )?(?:identität|persona|rolle als person) ist)/i,
  },
  {
    // "Answer as Mira": a name after "as". Case-sensitive: the capital is
    // what tells a name from "answer as bullet points".
    message: 'makes the agent speak as somebody else',
    pattern: /\b(?:[Ss]peak|[Aa]nswer|[Rr]espond|[Rr]eply|[Tt]alk)(?:s|ing)? as (?!(?:A|An|The|Facilitator|Moderator)\b)[A-Z][a-z]+\b/,
  },
  {
    // "You are Mira." / "You are Alex, the …": a proper name right after
    // "You are". Case-sensitive for the same reason.
    message: 'gives the agent another name',
    pattern: /\bYou are (?!(?:A|An|The|Now|Not|No|In|At|On|Here|There|Facilitator|Moderator)\b)[A-Z][a-z]+(?:\s[A-Z][a-z]+)?(?=[,.!:;]|\s(?:and|the|a|an)\b)/,
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
