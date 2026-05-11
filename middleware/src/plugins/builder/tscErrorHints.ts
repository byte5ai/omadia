import type { BuildError } from './buildErrorParser.js';

/**
 * tscErrorHints — annotate raw tsc diagnostics with actionable
 * Builder-specific guidance for the LLM. The B.6-13 live-test surfaced
 * a recurring class of errors that the agent kept reproducing because
 * the bare tsc message ("Generic type 'ToolDescriptor<I, O>' requires 2
 * type argument(s)") doesn't tell it WHICH pattern to use. We append a
 * `\nHint: …` line when the (code, message) pair matches a known
 * pattern; the hint is preserved in the structured `tscErrors[]` array
 * AND in the formatted top-5 error string so the agent sees it both
 * machine-readable and human-readable.
 *
 * Adding a new hint:
 *   1. Add an entry to KNOWN_HINTS below — match either by exact code
 *      or by code-plus-substring on the original message.
 *   2. Add a unit test in test/builder/tscErrorHints.test.ts.
 *
 * Hints stay short and actionable — they tell the agent the fix, not
 * the rationale. Long explanations belong in the system prompt
 * (B.7-4).
 */

interface HintRule {
  /** Exact tsc diagnostic code, e.g. 'TS2314'. */
  code: string;
  /**
   * Optional case-insensitive substring the original message must
   * contain. Multiple rules may share a code; the first matching rule
   * wins.
   */
  messageContains?: string;
  hint: string;
}

const KNOWN_HINTS: ReadonlyArray<HintRule> = [
  {
    code: 'TS2314',
    messageContains: 'ToolDescriptor',
    hint:
      'ToolDescriptor needs explicit generics. Use ' +
      '`ToolDescriptor<typeof inputSchema, typeof outputSchema>` — see ' +
      'the seo-analyst reference (read_reference name="seo-analyst" ' +
      'file="src/toolkit.ts") for the pattern.',
  },
  {
    code: 'TS2314',
    hint:
      'A generic type is missing its type arguments. Check the type ' +
      'definition (or the matching reference impl) to see how many ' +
      'arguments it expects.',
  },
  {
    code: 'TS7006',
    hint:
      'Parameter has an implicit `any` type. Annotate it explicitly: ' +
      'for tool handlers use `z.infer<typeof inputSchema>`; for ' +
      'callbacks, derive the type from the SDK signature.',
  },
  {
    code: 'TS2304',
    hint:
      'Identifier not found. Check imports — top-level imports come from ' +
      'the boilerplate, NOT the slot. If you need a runtime, import it via ' +
      'the slot signature (e.g. ctx.vault, ctx.log) instead of bare ' +
      'symbols.',
  },
  {
    code: 'TS2322',
    hint:
      'Type mismatch. Compare your return shape against the function ' +
      'signature in the boilerplate file. Often a missing field or a ' +
      'string where a Zod-inferred branded type is expected.',
  },
];

export function hintFor(code: string, message: string): string | null {
  const lower = message.toLowerCase();
  for (const rule of KNOWN_HINTS) {
    if (rule.code !== code) continue;
    if (rule.messageContains && !lower.includes(rule.messageContains.toLowerCase())) {
      continue;
    }
    return rule.hint;
  }
  return null;
}

export function annotateWithHint(error: BuildError): BuildError {
  const hint = hintFor(error.code, error.message);
  if (!hint) return error;
  return { ...error, message: `${error.message}\nHint: ${hint}` };
}

export function annotateAll(errors: ReadonlyArray<BuildError>): BuildError[] {
  return errors.map(annotateWithHint);
}
