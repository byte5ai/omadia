import type { PrivacyPromptMaskResult, PrivacyStoredTextScope } from '@omadia/plugin-api';

import { stripQuestion } from './literalStripping.js';

/**
 * Learned fast path — masking the stored example question.
 *
 * Plans are tenant-wide and must carry no user literals. Tool-input literals
 * are stripped structurally (literalStripping.ts), but a question can name a
 * person the tool input never contained ("Rechnungen, die Anna Schmidt
 * gebucht hat"). So before an example is stored, the ORIGINAL-case question
 * runs through the Privacy Shield's stored-text scope (C0 identity shapes,
 * deny-list, C1 person detector); every surrogate span becomes a typed
 * placeholder (`{{person}}`, `{{email}}`, …) and only then is the text
 * normalised. The stored example is built from the MASKED text only.
 *
 * Failure-closed: no privacy service, a `blocked` result, a degraded run, or
 * a run in which person names provably could not be checked (C1 unconfigured
 * — detected with a canary sentence, because an unconfigured C1 answers
 * "nothing found" exactly like a configured one on a name-free text) → no
 * example. Nothing here ever logs the question.
 */

export const STORED_TEXT_JOB = 'learned-fast-path-example';

/** Two unambiguous person names: a configured, healthy C1 finds them. */
export const PERSON_CANARY = 'Termin mit Anna Schmidt und Peter Wagner am Montag.';

export type MaskedExample = { ok: true; example: string } | { ok: false; detail: string };

const SAFE_TYPE = /^[a-z][a-z_]{1,20}$/;
const sentinel = (i: number): string => `zzpii${i}zz`;

/** Word-level LCS: which masked tokens are carried over from the original. */
function carriedTokens(original: readonly string[], masked: readonly string[]): boolean[] {
  const n = original.length;
  const m = masked.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = original[i] === masked[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const carried = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (original[i] === masked[j]) {
      carried[j] = true;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return carried;
}

/**
 * Replace every surrogate run of `maskedText` (tokens not carried over from
 * the original) by a sentinel, and name each sentinel's placeholder from the
 * span types: in order when the counts agree, else the run's own shape
 * (an e-mail) or the one type all spans share, else `{{pii}}`.
 */
export function markSurrogates(
  original: string,
  maskedText: string,
  spanTypes: readonly string[],
): { text: string; placeholders: Map<string, string> } {
  const masked = maskedText.split(/\s+/).filter((t) => t.length > 0);
  const carried = carriedTokens(original.split(/\s+/).filter((t) => t.length > 0), masked);
  const runs: string[][] = [];
  const out: string[] = [];
  masked.forEach((tok, k) => {
    if (carried[k]) {
      out.push(tok);
      return;
    }
    if (k > 0 && !carried[k - 1]) runs.at(-1)?.push(tok);
    else {
      runs.push([tok]);
      out.push(sentinel(runs.length - 1));
    }
  });
  const distinct = [...new Set(spanTypes)];
  const placeholders = new Map<string, string>();
  runs.forEach((run, i) => {
    const byOrder = runs.length === spanTypes.length ? spanTypes[i] : undefined;
    const shape = run.some((t) => t.includes('@')) ? 'email' : undefined;
    const raw = byOrder ?? shape ?? (distinct.length === 1 ? distinct[0] : undefined) ?? 'pii';
    const type = SAFE_TYPE.test(raw.toLowerCase()) ? raw.toLowerCase() : 'pii';
    placeholders.set(sentinel(i), `{{${type}}}`);
  });
  return { text: out.join(' '), placeholders };
}

function refusal(r: PrivacyPromptMaskResult, what: string): string | undefined {
  if (r.outcome === 'blocked') return `${what}-blocked`;
  if (r.outcome !== 'masked') return `${what}-${r.outcome}`;
  if (r.degraded) return `${what}-degraded`;
  return undefined;
}

/** The stored example for `question`, or why none may be stored. */
export async function maskExampleQuestion(
  question: string,
  literals: ReadonlyMap<string, string | number>,
  openScope: (() => PrivacyStoredTextScope | undefined) | undefined,
): Promise<MaskedExample> {
  let scope: PrivacyStoredTextScope | undefined;
  try {
    scope = openScope?.();
  } catch {
    scope = undefined;
  }
  if (!scope) return { ok: false, detail: 'privacy-unavailable' };
  try {
    const canary = await scope.maskStoredText(PERSON_CANARY);
    const canaryRefused = refusal(canary, 'canary');
    if (canaryRefused) return { ok: false, detail: canaryRefused };
    if (canary.outcome !== 'masked' || !canary.spans.some((s) => s.type === 'person')) {
      return { ok: false, detail: 'person-check-unavailable' };
    }
    const res = await scope.maskStoredText(question);
    const refused = refusal(res, 'question');
    if (refused || res.outcome !== 'masked') return { ok: false, detail: refused ?? 'question-unmasked' };
    const marked = markSurrogates(question, res.maskedText, res.spans.map((s) => s.type));
    let example = stripQuestion(marked.text, literals);
    for (const [s, ph] of marked.placeholders) example = example.split(s).join(ph);
    return example.length > 0 ? { ok: true, example } : { ok: false, detail: 'empty' };
  } catch {
    return { ok: false, detail: 'mask-error' };
  }
}
