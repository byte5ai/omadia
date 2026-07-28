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
    re: /\b(always|automatically|immer|automatisch)\b[^.\n]{0,24}\b(call|invoke|run|execute|use|aufrufen?|ausführen?|nutze?n?|verwende?n?)\b|\bwithout (?:asking|confirmation|permission|telling)\b|\bohne (?:zu fragen|nachfrage|rückfrage|bestätigung|erlaubnis)\b|\bbypass(?:ing)?\b|\bumgeh(?:e|en|st)\b/i,
  },
  {
    code: 'data_exfiltration',
    re: /\b(send|post|upload|exfiltrate|leak|forward|sende|poste|übermittle|leite\s+weiter|lade\s+hoch)\b[^.\n]{0,48}\b(api[ _-]?key|secret|token|password|credential|passwort|geheimnis|zugangsdaten|https?:\/\/)/i,
  },
  {
    code: 'credential_harvest',
    re: /\b(collect|gather|harvest|extract|copy|capture|sammle|extrahiere|kopiere|erfasse)\b[^.\n]{0,40}\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|passwörter|passwort|geheimnisse?|zugangsdaten)\b|\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|passwörter|passwort|geheimnisse?|zugangsdaten)\b[^.\n]{0,32}\b(collect|gather|harvest|extract|copy|capture|sammle|extrahiere|kopiere|erfasse)\b/i,
  },
  {
    code: 'silent_permission_escalation',
    re: /\b(grant|enable|request|claim|get|add|vergib|aktiviere|fordere|beanspruche|hole|füge)\b[^.\n]{0,40}\b(extra|additional|broader|admin|root|full|elevated|mehr|zusätzliche|erweiterte|admin|root|volle)\b[^.\n]{0,24}\b(permission|permissions|scope|access|rechte|berechtigungen|zugriff)\b|\bwithout\b[^.\n]{0,24}\b(telling|informing|mentioning)\b[^.\n]{0,24}\b(user|users)\b[^.\n]{0,24}\b(permission|permissions|scope|access)\b|\bohne\b[^.\n]{0,24}\b(den nutzer|die nutzer|zu informieren|zu erwähnen)\b[^.\n]{0,24}\b(rechte|berechtigungen|zugriff)\b/i,
  },
  {
    code: 'hidden_content',
    // HTML comment, zero-width chars, or a long base64-looking blob. Built via
    // new RegExp so the zero-width escapes stay visible in source.
    re: new RegExp('<!--|[\\u200B-\\u200D\\uFEFF]|[A-Za-z0-9+/]{200,}={0,2}'),
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
      risks.push({ code, severity: 'warn', excerpt: excerptAround(haystack, m.index, m[0].length) });
    }
  }
  return risks;
}

const SYNC_VERIFIERS: readonly Verifier[] = [regexPatternVerifier];

/**
 * Scan a skill's frontmatter + body for risky patterns. This synchronous path
 * only runs synchronous verifiers; async verifiers (Phase 1b LLM checks) are
 * invoked separately by the verdict service, never from this import-time path.
 */
export function scanSkillForRisks(
  frontmatter: Record<string, unknown>,
  body: string,
): SkillRisk[] {
  const risks: SkillRisk[] = [];
  for (const verifier of SYNC_VERIFIERS) {
    const result = verifier(frontmatter, body);
    if (result instanceof Promise) {
      throw new TypeError('scanSkillForRisks only supports synchronous verifiers');
    }
    risks.push(...result);
  }
  return risks;
}
