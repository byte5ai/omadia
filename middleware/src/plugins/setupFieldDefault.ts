/**
 * #1464 — the manifest `default` of a `boolean` setup field.
 *
 * Authors write it both ways: a YAML boolean (`default: true`) and a string
 * (`default: "true"`, e.g. the orchestrator manifest and dev-platform 0.3.5).
 * The install API already accepts both spellings as a submitted value
 * (`coerce()` in installService), so the declared default must too. Both
 * manifest projections — the catalog (`manifestLoader`) and the install schema
 * (`installService.extractSetupSchema`) — run the raw value through this one
 * function, so they can't disagree about it, and the value they hand on is
 * always a real boolean: the install form pre-checks on `true`, and the
 * server-side fallback / bootstrap seeding store `true`, never `"true"`.
 *
 * Anything else (`"yes"`, `1`, …) is not a boolean and is dropped (`undefined`):
 * the field then behaves as if it declared no default.
 */
export function booleanSetupDefault(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}
