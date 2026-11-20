import { ApiError } from '../../_lib/api';

/**
 * #2050 — the codes the Agent Builder answers a refused helper write with
 * (`409 { error: 'helper_refused', code }`). Each has its own sentence under
 * `admin.builder.helperErrors.<code>`.
 */
export const HELPER_REFUSAL_CODES = [
  'helper_name_collision',
  'helper_grant_not_held_by_agent',
  'helper_model_not_allowed',
] as const;

export type HelperRefusalCode = (typeof HELPER_REFUSAL_CODES)[number];

/** The helper refusal code of a failed call, or `null` for any other error. */
export function helperRefusalCode(err: unknown): HelperRefusalCode | null {
  if (!(err instanceof ApiError) || err.code === null) return null;
  return (HELPER_REFUSAL_CODES as readonly string[]).includes(err.code)
    ? (err.code as HelperRefusalCode)
    : null;
}
