/**
 * The seal that binds `agent_teams_identities.error_code` / `error_detail`
 * to the ONE `last_error` sentence they were written with
 * (byte5ai/omadia#897, migration 0060).
 *
 * WHY A SEAL. `AgentTeamsIdentityStore.update` writes the three columns
 * together, but only builds from #897 on know the two new ones exist. An
 * older image running against a database that is already on 0060 — which
 * the updater's automatic rollback after a failed health gate produces by
 * design (`sidecars/updater/README.md`, "What rollback does not undo") —
 * writes `last_error` alone: its clears leave the stale code behind, and its
 * next failure sentence lands next to that code. Trusting the code then
 * shows the operator a verdict that belongs to an earlier failure.
 *
 * So every coded write also stores, inside `error_detail`, a SHA-256 of the
 * sentence it describes (under a reserved key that never reaches the typed
 * arguments or the wire). A reader trusts the code only while that
 * fingerprint still matches the row's `last_error`; on a mismatch, a missing
 * fingerprint or a NULL code the row reads exactly like one written before
 * 0060 — the sentence classifier decides. The guarantee is therefore:
 * a code is never read against a sentence it was not written with, no matter
 * which build wrote the sentence.
 *
 * Platform-level because both writers live on different sides of the
 * `platform/` ↛ `services/` boundary: the store seals, the runner's read path
 * (`teamsProvisioningErrorDetailOf`, the config-sync warning cleanup) checks.
 */

import { createHash } from 'node:crypto';

/** Reserved `error_detail` key holding the sentence fingerprint. Not a
 *  member of any typed argument shape; stripped by {@link pairedTeamsErrorOf}. */
export const TEAMS_ERROR_SENTENCE_FINGERPRINT_KEY = 'sentenceSha256';

/** Hex SHA-256 of the exact `last_error` text. */
export function teamsErrorSentenceFingerprint(sentence: string): string {
  return createHash('sha256').update(sentence, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of `record` without the reserved fingerprint key. */
function withoutSeal(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== TEAMS_ERROR_SENTENCE_FINGERPRINT_KEY),
  );
}

/**
 * The `error_detail` value persisted next to a CODED sentence: the typed
 * arguments (a record, or nothing) plus the fingerprint of `lastError`.
 * Never `null` — a code without a seal would read as unpaired.
 */
export function sealTeamsErrorDetail(
  lastError: string,
  args: unknown,
): Readonly<Record<string, unknown>> {
  return {
    ...(isRecord(args) ? withoutSeal(args) : {}),
    [TEAMS_ERROR_SENTENCE_FINGERPRINT_KEY]: teamsErrorSentenceFingerprint(lastError),
  };
}

/** A stored code that was provably written with the row's current sentence. */
export interface PairedTeamsError {
  /** As stored — the caller validates it against its own vocabulary. */
  readonly errorCode: string;
  /** The typed arguments, fingerprint removed. `{}` for a code without any. */
  readonly errorArgs: Readonly<Record<string, unknown>>;
}

/**
 * The stored code and its arguments ONLY when they were sealed for exactly
 * `lastError`; `undefined` for a clean row, a pre-0060 row (NULL code), and a
 * row whose sentence was rewritten by a build that does not know the columns
 * (fingerprint missing or different). `undefined` means "classify the
 * sentence", never "no error".
 */
export function pairedTeamsErrorOf(
  lastError: string | null | undefined,
  errorCode: unknown,
  errorDetail: unknown,
): PairedTeamsError | undefined {
  if (typeof lastError !== 'string' || typeof errorCode !== 'string') return undefined;
  if (errorCode === '' || !isRecord(errorDetail)) return undefined;
  const seal = errorDetail[TEAMS_ERROR_SENTENCE_FINGERPRINT_KEY];
  if (seal !== teamsErrorSentenceFingerprint(lastError)) return undefined;
  return { errorCode, errorArgs: withoutSeal(errorDetail) };
}
