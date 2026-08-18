/**
 * #584 — Operator-owned per-agent transcription minute quota contract.
 *
 * Every installed plugin that contributes tools picks up a synthetic
 * `_transcription_minutes_quota` setup field (kernel-injected by
 * `extractSetupSchema`, the `_privacy_mode` precedent). The operator may
 * bound the agent's transcription spend: the metering layer enforces the
 * value as a per-calendar-month cap on **Billed Minutes** (level-triggered
 * pre-check — the crossing call completes, the next blocks).
 *
 * Empty / absent means UNLIMITED — the platform must carry no new
 * obligations for installations that never touch audio, so there is
 * deliberately no default.
 *
 * The constant lives here (not in the transcription contract package)
 * because both the install service (field injection) and the orchestrator's
 * metering hook (dispatch-time read via the installed-plugin config bag)
 * import it — the same split as `PRIVACY_MODE_CONFIG_KEY`.
 */

/** Config-key the install form writes the quota into. Leading underscore
 *  marks it as kernel-synthetic (not authored by the plugin). Value is an
 *  integer number of Billed Minutes per calendar month; absent = unlimited. */
export const TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY =
  '_transcription_minutes_quota';
