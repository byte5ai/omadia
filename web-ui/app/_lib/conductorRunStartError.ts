import { ApiError } from './api';

/**
 * #1711 — "Starten" used to render the engine's refusal verbatim, so a workflow
 * that a template instantiation had left `disabled` answered the operator with
 * `POST /v1/operator/conductors/onb-probe/runs failed: 409`. That is both an
 * i18n hard-rule violation (never raw ApiError text as the primary message) and
 * useless: the sentence has to say the workflow is inactive, because the fix is
 * a switch in the very list the operator is looking at.
 *
 * The run-start route refuses with exactly three machine codes
 * (`middleware/src/conductor/routes.ts` POST /:slug/runs): `conductor.disabled`
 * and `conductor.not_published` as 409, `conductor.not_found` as 404. Each maps
 * to one catalog key under the `conductor` namespace; everything else keeps the
 * generic `runError` sentence and carries the technical text as a secondary
 * detail line, so nothing is lost for debugging while the primary text stays
 * localized.
 */
export type ConductorRunStartErrorKey =
  | 'runDisabledError'
  | 'runNotPublishedError'
  | 'runNotFoundError'
  | 'runError';

export interface ConductorRunStartError {
  /** Key under the `conductor` i18n namespace — always a catalog sentence. */
  key: ConductorRunStartErrorKey;
  /**
   * Technical text shown *behind* the sentence. Null for the three known
   * refusals: their catalog sentence already says what happened and what to do,
   * and repeating the server's English under it adds noise, not information.
   */
  detail: string | null;
}

const BY_CODE: Record<string, ConductorRunStartErrorKey> = {
  'conductor.disabled': 'runDisabledError',
  'conductor.not_published': 'runNotPublishedError',
  'conductor.not_found': 'runNotFoundError',
};

export function describeConductorRunStartError(err: unknown): ConductorRunStartError {
  const mapped = err instanceof ApiError && err.code !== null ? BY_CODE[err.code] : undefined;
  if (mapped) return { key: mapped, detail: null };
  const detail = err instanceof ApiError ? (err.serverMessage ?? err.message) : err instanceof Error ? err.message : String(err);
  return { key: 'runError', detail: detail.trim().length > 0 ? detail : null };
}
