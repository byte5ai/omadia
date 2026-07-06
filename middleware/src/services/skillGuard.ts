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
  | 'hidden_content';

export interface SkillRisk {
  readonly code: SkillRiskCode;
  readonly severity: 'warn';
  /** Short snippet showing what matched, for the preview. */
  readonly excerpt: string;
}

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
 * Scan a skill's frontmatter + body for risky patterns. Returns at most one
 * risk per code (first match), so the preview stays readable.
 */
export function scanSkillForRisks(
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
