import type { PrivacyRenderedAnswer } from '@omadia/plugin-api';

/**
 * #1769 — a turn may call `v4_render_answer` more than once (three routines
 * created in one message, two diagrams). Every call tells the model its render
 * was shown, so every render must reach the user: the turn keeps all of them
 * and the kernel receives them joined in call order.
 *
 * - `text` and `prose` are joined with a blank line, in call order; an empty
 *   prose adds nothing, so `''` still means "no prose" (system data only).
 * - `maskedValues` is the distinct union, first occurrence first.
 * - `isError` only when every render is a rendered failure: one real result
 *   next to an error is not presented as a failure as a whole.
 */
export function joinRenderedAnswers(
  answers: readonly PrivacyRenderedAnswer[],
): PrivacyRenderedAnswer | undefined {
  const first = answers[0];
  if (first === undefined) return undefined;
  if (answers.length === 1) return first;
  const proseParts = answers
    .map((a) => a.prose ?? '')
    .filter((p) => p.trim() !== '');
  const isError = answers.every((a) => a.isError === true);
  return {
    text: answers.map((a) => a.text).join('\n\n'),
    maskedValues: [...new Set(answers.flatMap((a) => a.maskedValues))],
    // `prose` is absent only from a provider that predates the field; one
    // render without it leaves the joined answer without it, so the kernel
    // still fails closed.
    ...(answers.every((a) => a.prose !== undefined)
      ? { prose: proseParts.join('\n\n') }
      : {}),
    ...(isError ? { isError: true } : {}),
  };
}
