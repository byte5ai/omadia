import { serverErrorCode, serverErrorMessage } from '../../_lib/apiErrorMessage';

/**
 * #1754 / #1758 — what a failed routines call shows: a localized headline for
 * the codes the page can explain, else the caller's generic headline, with
 * the server's own reason (untranslated) as the detail line — never the
 * client's transport line (`… failed: 400`).
 */
export interface RoutineErrorText {
  readonly headline: string;
  readonly detail: string | null;
}

/** Route codes of `/api/v1/routines` → keys of `routines.actions`. */
const KNOWN_CODES: Readonly<Record<string, string>> = {
  'routines.chat_unavailable': 'triggerChatUnavailable',
  'routines.not_active': 'triggerNotActive',
  'routines.run_in_progress': 'triggerRunning',
  'routines.agent_unavailable': 'triggerAgentUnavailable',
};

export function routineErrorText(
  err: unknown,
  t: (key: string) => string,
  fallbackHeadline: string,
): RoutineErrorText {
  const code = serverErrorCode(err);
  const known = code ? KNOWN_CODES[code] : undefined;
  if (known) return { headline: t(known), detail: null };
  return { headline: fallbackHeadline, detail: serverErrorMessage(err) };
}
