/**
 * Privacy Shield v4 — feature flag.
 *
 * The entire v4 data-plane boundary is gated. With the flag off (the default)
 * the existing v2/v3 token path runs unchanged and no v4 code is invoked
 * (FR-026) — this keeps the flag-off test suite byte-identical (SC-009).
 *
 * v1 mechanism: a process-global env flag. There is no per-agent config
 * layer in the middleware yet, so "v4 for the HR agent" is expressed by
 * running that agent's deployment with `PRIVACY_SHIELD_V4=on`. When a
 * per-agent config layer lands, `isV4Enabled` gains an agentId-aware path
 * without changing its callers.
 *
 * Accepted truthy values (case-insensitive): `on`, `true`, `1`, `yes`.
 */

const TRUTHY = new Set(['on', 'true', '1', 'yes']);

/** True when the Privacy Shield v4 data-plane boundary is enabled. */
export function isV4Enabled(): boolean {
  const raw = process.env.PRIVACY_SHIELD_V4;
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
