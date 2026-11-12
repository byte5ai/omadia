/**
 * Import-time risk scan for skill content (untrusted-by-default, #391).
 *
 * Imported SKILL.md is third-party text that becomes a sub-agent's system
 * prompt once attached and run. This is a lightweight, heuristic pre-activation
 * check: it surfaces likely prompt-injection / instruction-smuggling patterns so
 * the human sees them before confirming an import. It is deliberately
 * warn-only — it never blocks (the preview-then-confirm flow keeps a human in
 * the loop) and it is not a substitute for the runtime guards. False positives
 * are acceptable here; missing a smuggled instruction is worse than over-warning.
 */

export type SkillRiskCode =
  | 'instruction_override'
  | 'system_prompt_reference'
  | 'tool_coercion'
  | 'data_exfiltration'
  | 'hidden_content'
  | 'credential_harvest'
  | 'silent_permission_escalation';

export interface SkillRisk {
  readonly code: SkillRiskCode;
  readonly severity: 'warn';
  /** Short snippet showing what matched, for the preview. */
  readonly excerpt: string;
}

export type Verifier = (
  frontmatter: Record<string, unknown>,
  body: string,
) => SkillRisk[] | Promise<SkillRisk[]>;

interface Pattern {
  readonly code: SkillRiskCode;
  readonly re: RegExp;
}

const CREDENTIAL_HARVEST_RE = new RegExp(
  [
    String.raw`\b(collect|gather|harvest|extract|copy|capture|sammle|extrahiere|kopiere|erfasse)\b[^.\n]{0,40}\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|passwörter|passwort|geheimnisse?|zugangsdaten)\b`,
    String.raw`\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|passwörter|passwort|geheimnisse?|zugangsdaten)\b[^.\n]{0,32}\b(collect|gather|harvest|extract|copy|capture|sammle|extrahiere|kopiere|erfasse)\b`,
    String.raw`(?<![\p{L}\p{N}_])(?:read|open|access|load|cat|copy|inspect|retrieve|lies|lese|lesen|öffne|öffnen|auslesen|abrufen|lade|kopiere)(?![\p{L}\p{N}_])[\s\S]{0,96}(?:(?:\.cursor[\\/]+)?mcp\.json|\.ssh(?:[\\/](?:id_[\w.-]+|config|known_hosts))?|\.aws[\\/]credentials|(?<![\w.-])\.env(?:\.[\w-]+)?(?![\w-]))[\s\S]{0,96}(?<![\p{L}\p{N}_])(?:pass|provide|supply|send|forward|include|share|weitergeben|gib|reiche|übermittle|leite)(?![\p{L}\p{N}_])[\s\S]{0,48}\b(?:content|contents|data|inhalt|daten)\b[\s\S]{0,32}\b(?:as|into|to|in|als)\b[\s\S]{0,24}\b(?:arguments?|parameters?|note|sidenote)\b`,
  ].join('|'),
  'iu',
);

const SILENT_PERMISSION_ESCALATION_RE = new RegExp(
  [
    String.raw`\b(grant|enable|request|claim|get|add|vergib|aktiviere|fordere|beanspruche|hole|füge)\b[^.\n]{0,40}\b(extra|additional|broader|admin|root|full|elevated|mehr|zusätzliche|erweiterte|admin|root|volle)\b[^.\n]{0,24}\b(permission|permissions|scope|access|rechte|berechtigungen|zugriff)\b`,
    String.raw`\bwithout\b[^.\n]{0,24}\b(telling|informing|mentioning)\b[^.\n]{0,24}\b(user|users)\b[^.\n]{0,24}\b(permission|permissions|scope|access)\b`,
    String.raw`\bohne\b[^.\n]{0,24}\b(den nutzer|die nutzer|zu informieren|zu erwähnen)\b[^.\n]{0,24}\b(rechte|berechtigungen|zugriff)\b`,
    String.raw`\b(?:do not|don't|never)\b[^.!?\n]{0,32}\b(?:mention|tell|inform|disclose|reveal)\b[\s\S]{0,96}\b(?:user|anyone|read(?:ing)?|file|action)\b`,
    String.raw`\b(?:hide|conceal)\b[\s\S]{0,80}\b(?:from\s+the\s+user|the\s+user|this\s+action|the\s+file)\b`,
    String.raw`\bkeep\b[\s\S]{0,64}\b(?:from\s+the\s+user|secret|hidden)\b`,
    String.raw`\b(?:erwähn(?:e|t|en|st)?|sag(?:e|t|en|st)?|informier(?:e|t|en|st)?)\b[^.!?\n]{0,64}\b(?:nicht|niemals)\b[\s\S]{0,96}\b(?:nutzer|benutzer|datei|lesen|aktion|vorgang)\b`,
    String.raw`\b(?:erwähn(?:e|t|en|st)?|sag(?:e|t|en|st)?|informier(?:e|t|en|st)?)\b[\s\S]{0,80}\b(?:nutzer|benutzer)\b[^.!?\n]{0,40}\bnicht\b`,
    String.raw`\b(?:verheimlich(?:e|t|en|st)?|verschweig(?:e|t|en|st)?|verberg(?:e|t|en|st)?)\b[\s\S]{0,80}\b(?:nutzer|benutzer|datei|lesen|aktion|vorgang|inhalt)\b`,
    String.raw`\bhalte\b[\s\S]{0,80}\b(?:vor\s+(?:dem|der)\s+(?:nutzer|benutzer)|geheim|verborgen)\b`,
  ].join('|'),
  'iu',
);

const HIDDEN_CONTENT_RE = new RegExp(
  String.raw`<!--|<\/?\s*(?:important|system|developer)\b[^>]*>|[\u200B-\u200D\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]|[A-Za-z0-9+/]{200,}={0,2}`,
  'iu',
);

const PATTERNS: readonly Pattern[] = [
  // Patterns cover English + German (omadia is German-facing), so a German
  // injection like "ignoriere alle vorherigen Anweisungen" is caught too. All
  // quantifiers stay upper-bounded — no catastrophic backtracking.
  {
    code: 'instruction_override',
    re: /\b(ignore|disregard|forget|override|ignorier(?:e|t)?|missachte|vergiss|überschreib(?:e|t)?)\b[^.\n]{0,48}\b(previous|prior|above|earlier|all|any|vorherige[nr]?|obige[nr]?|frühere[nr]?|alle|jegliche)\b[^.\n]{0,24}\b(instructions?|prompts?|rules?|guidelines?|context|anweisung(?:en)?|regeln?|vorgaben?|kontext)\b/i,
  },
  {
    code: 'system_prompt_reference',
    re: /\b(system prompt|system message|system-?prompt|systemnachricht|you are now|from now on,? you|act as (?:if )?(?:a|an|the)\b|du bist (?:ab )?jetzt|ab (?:jetzt|sofort) bist du|handle als|agiere als)/i,
  },
  {
    code: 'tool_coercion',
    // The German half of this pattern was verified against a REAL hostile
    // skill during the packaged-app retest (2026-08-20) and missed all four
    // sentences. The gaps, each closed below with a bounded quantifier:
    //   - separable verbs put the particle at the END: "führe IMMER sofort
    //     das Kalkulations-Tool aus" — the verb precedes the adverb, so
    //     `(immer)…(ausführen)` never matches. Covered by the
    //     `(führe|führt|führen)…aus` alternative gated on a coercion adverb
    //     to keep innocent "führe X aus" instructions unflagged.
    //   - "erzwinge den Tool-Aufruf" — erzwingen was not in the verb list.
    //   - "überspringe jede Rückfrage" — überspringen was not in the list.
    //   - "ohne den Nutzer um Bestätigung zu fragen" — the old
    //     `\bohne (?:zu fragen|bestätigung|…)\b` required the object to
    //     follow "ohne" immediately; real German puts words in between.
    re: /\b(always|automatically|immer|automatisch)\b[^.\n]{0,24}\b(call|invoke|run|execute|use|aufrufen?|ausführen?|nutze?n?|verwende?n?)\b|\b(immer|automatisch|sofort)\b[^.\n]{0,48}\b(aufrufen|ausführen|auszuführen)\b|\b(führe|führt|führen)\b[^.\n]{0,12}\b(immer|sofort|automatisch|ungefragt|stets)\b[^.\n]{0,48}\baus\b|\berzwing(?:e|t|en|st)\b|(?<![a-zA-ZäöüÄÖÜß])überspring(?:e|t|en|st)\b[^.\n]{0,32}(?<![a-zA-ZäöüÄÖÜß])(rückfragen?|nachfragen?|bestätigung(?:en)?|abfragen?|sicherheitsabfragen?)\b|\bwithout (?:asking|confirmation|permission|telling)\b|\bohne\b[^.\n]{0,40}\b(zu fragen|nachfrage|rückfrage|bestätigung|erlaubnis|sicherheitsabfrage)\b|\bignorier(?:e|t|en|st)\b[^.\n]{0,32}\b(sicherheitsabfragen?|warnungen?|rückfragen?|bestätigungen?)\b|\bbypass(?:ing)?\b|\bumgeh(?:e|en|st)\b/i,
  },
  {
    code: 'data_exfiltration',
    re: /\b(send|post|upload|exfiltrate|leak|forward|sende|poste|übermittle|leite\s+weiter|lade\s+hoch)\b[^.\n]{0,48}\b(api[ _-]?key|secret|token|password|credential|passwort|geheimnis|zugangsdaten|https?:\/\/)/i,
  },
  {
    code: 'credential_harvest',
    // Forwarding a sensitive local file into a tool argument is credential harvesting.
    re: CREDENTIAL_HARVEST_RE,
  },
  {
    code: 'silent_permission_escalation',
    re: SILENT_PERMISSION_ESCALATION_RE,
  },
  {
    code: 'hidden_content',
    // Pseudo-tags and invisible formatting controls, plus long base64 blobs.
    re: HIDDEN_CONTENT_RE,
  },
];

function excerptAround(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 16);
  const end = Math.min(text.length, index + matchLen + 16);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
}

/**
 * Regex-based verifier for import-time risk scans. Returns at most one risk
 * per code (first match), so the preview stays readable.
 */
export function regexPatternVerifier(
  frontmatter: Record<string, unknown>,
  body: string,
): SkillRisk[] {
  const haystack = `${JSON.stringify(frontmatter)}\n${body}`;
  const risks: SkillRisk[] = [];
  for (const { code, re } of PATTERNS) {
    const m = re.exec(haystack);
    if (m) {
      risks.push({
        code,
        severity: 'warn',
        excerpt: excerptAround(haystack, m.index, m[0].length),
      });
    }
  }
  return risks;
}

const SYNC_VERIFIERS: readonly Verifier[] = [regexPatternVerifier];

/**
 * Scan a skill's frontmatter + body for risky patterns. This synchronous path
 * only runs synchronous verifiers; async verifiers (Phase 1b LLM checks) are
 * invoked separately by the verdict service, never from this import-time path.
 *
 * #1219 — `description` is scanned as well: it is the routing text of the
 * sub-agent's delegation tool, so it reaches the PARENT orchestrator's system
 * prompt and tool list, a wider audience than the body. It is scanned as text
 * ahead of the body, so the verifiers need no new parameter.
 */
export function scanSkillForRisks(
  frontmatter: Record<string, unknown>,
  body: string,
  description?: string | null,
): SkillRisk[] {
  const text =
    typeof description === 'string' && description.trim().length > 0
      ? `${description}\n${body}`
      : body;
  const risks: SkillRisk[] = [];
  for (const verifier of SYNC_VERIFIERS) {
    const result = verifier(frontmatter, text);
    if (result instanceof Promise) {
      throw new TypeError('scanSkillForRisks only supports synchronous verifiers');
    }
    risks.push(...result);
  }
  return risks;
}
