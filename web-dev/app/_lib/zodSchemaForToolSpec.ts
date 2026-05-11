// -----------------------------------------------------------------------------
// Frontend mirror of middleware/src/plugins/builder/agentSpec.ts:ToolSpecSchema.
// Kept in sync MANUALLY until a shared types package exists (tracked as
// B.11+ tech-debt). The mirror is intentionally minimal — only the rules
// the form layer enforces before calling PATCH /spec. The server still
// owns canonical validation; this layer's job is zero-roundtrip feedback
// for typos.
//
// File-name keeps the `zodSchema…` prefix per the B.11 hand-off; the
// implementation is hand-rolled regex + length checks because zod is not
// a frontend dep (and adding it for two rules would be wasteful). If a
// future builder field needs richer constraints, swap this module for a
// real zod schema.
// -----------------------------------------------------------------------------

export const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

const TOOL_ID_RULE_HUMAN =
  'Tool-ID muss snake_case sein (Kleinbuchstaben, Ziffern, Unterstrich; Beginn mit Buchstabe)';

export interface ToolFieldErrors {
  id?: string;
  description?: string;
}

export function validateToolId(value: string): string | undefined {
  if (value.length === 0) return 'Tool-ID darf nicht leer sein';
  if (!TOOL_ID_PATTERN.test(value)) return TOOL_ID_RULE_HUMAN;
  return undefined;
}

export function validateToolDescription(value: string): string | undefined {
  if (value.trim().length === 0) return 'Beschreibung darf nicht leer sein';
  return undefined;
}

/** Validate a tool's mutable fields and return per-field error messages.
 *  Empty object means valid. */
export function validateToolFields(input: {
  id: string;
  description: string;
}): ToolFieldErrors {
  const errors: ToolFieldErrors = {};
  const idErr = validateToolId(input.id);
  if (idErr) errors.id = idErr;
  const descErr = validateToolDescription(input.description);
  if (descErr) errors.description = descErr;
  return errors;
}
