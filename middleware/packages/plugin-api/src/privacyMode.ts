/**
 * Slice 2.5 — Operator-owned per-plugin Privacy Mode contract.
 *
 * Every installed plugin that contributes tools picks up a synthetic
 * `_privacy_mode` setup field (kernel-injected by `extractSetupSchema`).
 * The operator selects how the orchestrator's dispatch hook should treat
 * raw tool results from that plugin:
 *
 *   - `guarded`  default — every raw result is interned behind the
 *                Privacy Shield v4 Data-Plane Boundary; the LLM sees only
 *                an identity-free digest. Safe-by-default.
 *   - `bypass`   the orchestrator passes raw results through unmasked;
 *                the LLM sees real values. Operator opt-in for sources
 *                the operator trusts AND whose shape v4 cannot usefully
 *                summarise (document-shaped pages, binary blobs, …).
 *                A `BypassedToolEntry` lands in the receipt for every
 *                dispatch so the user sees a transparency notice.
 *   - `per_tool` advanced — the operator picks specific tool names via
 *                `_privacy_bypass_scopes`; non-listed tools stay
 *                `guarded`. Use when one plugin contributes both
 *                v4-friendly (search hits, row-shape) and v4-incompatible
 *                (document bodies) tools.
 *
 * Compliance override — the org-level env var
 * `OMADIA_PRIVACY_FORCE_GUARDED=true` clamps every plugin to `guarded`
 * regardless of operator settings. UI MUST surface the override as a
 * "Locked by org policy" badge.
 *
 * The constants here are imported by both the orchestrator dispatch hook
 * (to resolve the mode at dispatch time) AND the install service (to
 * inject the synthetic field into every plugin's setup schema).
 */

/** Config-key the operator-UI writes the selected mode into. Leading
 *  underscore marks it as kernel-synthetic (not authored by the plugin). */
export const PRIVACY_MODE_CONFIG_KEY = '_privacy_mode';

/** Config-key for the per-tool override list (only meaningful when
 *  `_privacy_mode === 'per_tool'`). Stored as a `string[]` of tool names. */
export const PRIVACY_BYPASS_SCOPES_CONFIG_KEY = '_privacy_bypass_scopes';

/** Org-policy env var. When `'true'`, every plugin is clamped to
 *  `guarded` regardless of the operator's per-plugin setting. */
export const PRIVACY_FORCE_GUARDED_ENV_VAR = 'OMADIA_PRIVACY_FORCE_GUARDED';

/** Allowed values for `_privacy_mode`. Order is the UI-display order. */
export const PRIVACY_MODE_VALUES = ['guarded', 'bypass', 'per_tool'] as const;

export type PrivacyMode = (typeof PRIVACY_MODE_VALUES)[number];

/** Universal default. Picked when the operator never opened the dropdown. */
export const PRIVACY_MODE_DEFAULT: PrivacyMode = 'guarded';

/**
 * Resolve the effective mode for a tool given (a) the plugin's stored
 * config and (b) the org-policy env var. Pure — no IO. Callable from the
 * orchestrator dispatch hook AND from tests with synthetic inputs.
 *
 * `toolName` is consulted only for `per_tool` mode; ignored otherwise.
 */
export function resolveEffectivePrivacyMode(input: {
  /** The value stored at `config[_privacy_mode]`, or `undefined` if the
   *  operator never set one. */
  readonly storedMode: unknown;
  /** The value stored at `config[_privacy_bypass_scopes]`, or `undefined`.
   *  Consulted only when `storedMode === 'per_tool'`. */
  readonly storedScopes: unknown;
  /** The tool name being dispatched. */
  readonly toolName: string;
  /** Process env — pass `process.env` from the caller. The hook reads
   *  `PRIVACY_FORCE_GUARDED_ENV_VAR`; everything else is ignored. */
  readonly env: NodeJS.ProcessEnv;
}): 'guarded' | 'bypass' {
  // Org-policy override is absolute — it short-circuits before any other
  // resolution so the audit story is simple: "FORCE_GUARDED was on → no
  // bypass ever fired this turn, end of story".
  if (input.env[PRIVACY_FORCE_GUARDED_ENV_VAR] === 'true') return 'guarded';
  const mode = isPrivacyMode(input.storedMode)
    ? input.storedMode
    : PRIVACY_MODE_DEFAULT;
  if (mode === 'guarded') return 'guarded';
  if (mode === 'bypass') return 'bypass';
  // per_tool — bypass iff the tool name is in the operator's whitelist.
  // Tolerant parsing — accept both forms the install flow may produce:
  //   - array of strings (programmatic API write)
  //   - comma- or whitespace-separated string (manual operator entry
  //     via the install UI, which uses a plain `string` field for
  //     simplicity in Slice 2.5d MVP)
  for (const tool of parseScopes(input.storedScopes)) {
    if (tool === input.toolName) return 'bypass';
  }
  return 'guarded';
}

/** Parse the scope-list config value to a flat tool-name array. Trims
 *  entries and drops empty/non-string items. Idempotent across both
 *  array and string inputs. Exported for the install-service validator. */
export function parseScopes(stored: unknown): readonly string[] {
  if (Array.isArray(stored)) {
    return stored
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof stored === 'string' && stored.length > 0) {
    return stored
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function isPrivacyMode(v: unknown): v is PrivacyMode {
  return (
    typeof v === 'string' &&
    (PRIVACY_MODE_VALUES as readonly string[]).includes(v)
  );
}
