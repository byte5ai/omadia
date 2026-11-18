import { PRIVACY_FORCE_GUARDED_ENV_VAR } from '@omadia/plugin-api';

/**
 * #1535 — does the org policy `OMADIA_PRIVACY_FORCE_GUARDED` require the
 * Privacy Shield? The same comparison `resolveEffectivePrivacyMode` and the
 * admin posture (`privacyPosture.ts`) make, so the clamp, the store's lock and
 * the fail-closed turn never disagree.
 *
 * With the policy on, a turn that would reach a model without masking is
 * refused instead: no `privacy.redact@1` provider running (failed boot
 * activation, a reactivation in flight, a tripped breaker) on the in-process
 * path, and every turn on the subscription-CLI path, which has no shield.
 */
export function isPrivacyForceGuarded(env: NodeJS.ProcessEnv): boolean {
  return env[PRIVACY_FORCE_GUARDED_ENV_VAR] === 'true';
}
