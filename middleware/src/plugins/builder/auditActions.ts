/**
 * Audit-action constants for issue #56 (F6a scope).
 *
 * Centralised so downstream readers (UI timeline F6b, future analytics)
 * can do exhaustive switch-cases over the action string. Action strings
 * are stable identifiers — never rename without a migration that
 * rewrites existing rows.
 *
 * Router-mutation actions (INSTALLED / ARCHIVED / RESTORED /
 * SNAPSHOT_CREATED) are deferred to F6c per the issue scoping decision.
 */

export const BuilderAuditAction = {
  PERSONA_UPDATED: 'persona_updated',
  QUALITY_UPDATED: 'quality_updated',
  SPEC_PATCHED: 'spec_patched',
  SLOT_FILLED: 'slot_filled',
} as const;

export type BuilderAuditActionId =
  (typeof BuilderAuditAction)[keyof typeof BuilderAuditAction];
