/**
 * OM-09 — the localized error-help catalogue.
 *
 * WHY THIS EXISTS. The middleware has no request locale: nothing there reads
 * `Accept-Language`, and `NEXT_LOCALE` never leaves the Next.js layer. Every
 * `message` it puts on an error envelope is therefore English by construction,
 * and every screen that rendered one was showing a German operator an English
 * sentence — or, in the worst case, the raw identifier next to it
 * (`runtime.vault_unavailable: vault not wired into runtime route`).
 *
 * What the middleware *does* ship is a stable machine code. `ApiError.code`
 * (see api.ts) parses it once; this module maps it to two localized sentences:
 * `what` (what happened) and `next` (the one action that resolves it). Same
 * shape as {@link resolveSetupFieldHint} in setupFieldPattern.ts and the same
 * code-to-copy indirection as `SCAN_FAILURE_CODES` in scanFailure.ts — no
 * third pattern is invented here.
 *
 * SCOPE. The catalogue covers the codes emitted by six route files:
 * `install.ts`, `runtime.ts`, `runtimeGrants.ts`, `adminProviders.ts`,
 * `store.ts` and `adminSettings.ts`, plus the non-route codes
 * `providers.key_rejected`, `package.id_conflict_bundled` and
 * `cli_install.*`, which their services set rather than a route file. The
 * rest of the middleware's codes are deliberately not covered yet.
 *
 * `__tests__/errorHelpCoverage.test.ts` holds the scope to that promise. It
 * reads `code: '…'` literals out of the six files, FOLLOWS `install.ts`'s
 * `handleError` into `plugins/installService.ts` for the codes it re-emits
 * from a thrown `InstallError`, and fails on any `code:` in a covered file
 * that is neither a literal nor a registered, explained non-literal. Within
 * those five files it fails the moment one grows a code with no copy behind
 * it; outside them it claims nothing.
 */

/**
 * Every code with copy in `messages/*.json` under `errorHelp.<code>`.
 *
 * Keep alphabetical inside each family. `errorHelpCoverage.test.ts` asserts
 * this list matches what the covered route files actually emit, in BOTH
 * directions: a new code without copy fails, and copy without an emitter
 * fails as an orphan.
 */
export const ERROR_HELP_CODES = [
  // install.ts — the four it emits as literals, plus the ten its handleError
  // re-emits from an InstallError thrown in plugins/installService.ts.
  'install.already_installed',
  'install.blocked',
  'install.capability_already_provided',
  'install.has_dependents',
  'install.invalid_body',
  'install.invalid_job_id',
  'install.invalid_plugin_id',
  'install.job_not_found',
  'install.missing_capability',
  'install.missing_dependencies',
  'install.no_schema',
  'install.not_installed',
  'install.unexpected',
  'install.wrong_state',
  // cli_install.* — set by startCliInstall in
  // middleware/src/platform/cliInstallService.ts and returned on the
  // install-status poll response, not on an error envelope.
  'cli_install.no_output',
  'cli_install.npm_failed',
  // adminProviders.ts (+ providerCredentialVerifier.ts for key_rejected)
  'providers.apply_failed',
  'providers.invalid_request',
  'providers.key_rejected',
  'providers.model_provider_mismatch',
  'providers.not_installed',
  'providers.oauth_poll_failed',
  'providers.oauth_start_failed',
  'providers.oauth_too_many_flows',
  'providers.oauth_unsupported',
  'providers.read_failed',
  'providers.tool_incompatible',
  'providers.unknown_plugin',
  'providers.unknown_provider',
  'providers.verify_failed',
  // #789 — emitted by plugins/packageUploadService.ts, not by a route file.
  // Registered in NON_ROUTE_CODES for the same reason
  // `providers.key_rejected` is: the ingest service builds the envelope and
  // routes/packages.ts + builder/installCommit.ts only forward it.
  'package.id_conflict_bundled',
  // runtime.ts
  'runtime.agent_inactive',
  'runtime.empty_secrets_patch',
  // #470 C16 (#817) — a second consent change arrived for a plugin whose first
  // one is still being applied. Refused rather than queued; see
  // `consentInFlight` in middleware/src/routes/runtimeGrants.ts.
  'runtime.grants_in_flight',
  'runtime.invalid_audit_mode',
  'runtime.invalid_config',
  // #470 C16 (#817) — the unified grant-consent route. `sql_not_declared`
  // and `public_path_not_declared` are the same rule stated twice, once per
  // grant: consent is capped by what the manifest asks for, so this surface
  // can never itself be used to hand a plugin something it did not request.
  'runtime.invalid_grants',
  'runtime.invalid_id',
  // #603 (OM-17) — the `json_file` upload path. The `json_file_*` codes mirror
  // `JsonFileFailure` in `middleware/src/plugins/setupJsonFile.ts`; the two
  // spec-level ones say plainly that the fault is in the plugin, not in the
  // operator's file, because that distinction is the whole difference between
  // "try another file" and "report this".
  'runtime.invalid_json_file_body',
  'runtime.invalid_multiselect',
  // #470 C4/H1 — the public-path consent endpoint. `public_path_not_declared`
  // is the one an operator is most likely to hit: consent is capped by what the
  // manifest asks for, so a path the plugin never declared is refused rather
  // than quietly granted.
  'runtime.invalid_public_path',
  'runtime.invalid_public_paths',
  'runtime.ledger_already_owned',
  'runtime.invalid_secrets_body',
  'runtime.json_file_bad_extract_path',
  'runtime.json_file_invalid_spec',
  'runtime.json_file_missing_value',
  'runtime.json_file_not_an_object',
  'runtime.json_file_not_json',
  'runtime.json_file_too_large',
  'runtime.json_file_unexpected_document',
  'runtime.unknown_json_file_field',
  'runtime.no_options_provider',
  'runtime.not_installed',
  'runtime.not_web_scanner',
  'runtime.options_provider_bad_shape',
  'runtime.options_provider_failed',
  'runtime.options_provider_timeout',
  'runtime.options_unavailable',
  'runtime.public_path_not_declared',
  'runtime.public_paths_unavailable',
  'runtime.sql_grants_unavailable',
  'runtime.sql_not_declared',
  'runtime.setup_field_invalid',
  'runtime.update_failed',
  'runtime.value_not_offered',
  'runtime.vault_read_failed',
  'runtime.vault_unavailable',
  'runtime.vault_write_failed',
  // adminSettings.ts
  'settings.invalid_request',
  'settings.invalid_values',
  'settings.no_valid_changes',
  'settings.read_failed',
  'settings.vault_unavailable',
  'settings.write_failed',
  // store.ts
  'store.ack_failed',
  'store.get_failed',
  'store.invalid_id',
  'store.list_failed',
  'store.plugin_not_found',
  'store.verdict_not_found',
  'store.verdicts_unavailable',
] as const;

export type ErrorHelpCode = (typeof ERROR_HELP_CODES)[number];

export interface ErrorHelp {
  /** One sentence: what happened, in the operator's language. */
  readonly what: string;
  /** One imperative sentence: the action that resolves it. */
  readonly next: string;
  /** In-app route that carries out `next`, when one exists. */
  readonly actionHref?: string;
}

/**
 * Codes whose fix lives on a DIFFERENT page than the one showing the error.
 *
 * Routes only — a user-facing label would be a hardcoded string in a `.ts`
 * file, which `web-ui/CLAUDE.md` forbids; the label is `errorHelp.<code>.action`
 * in the message catalogue. Deliberately sparse: a link back to the page the
 * operator is already on is noise, not help.
 */
export const ERROR_HELP_ACTIONS: Readonly<Record<string, string>> = {
  'install.not_installed': '/store',
  'providers.not_installed': '/store',
  'runtime.not_installed': '/store',
  'store.plugin_not_found': '/store',
};

const CATALOGUED = new Set<string>(ERROR_HELP_CODES);

/** Is this code one the catalogue has copy for? */
export function isErrorHelpCode(
  code: string | null | undefined,
): code is ErrorHelpCode {
  return typeof code === 'string' && CATALOGUED.has(code);
}

/**
 * Resolve a middleware error code to localized help, or `null` when the code
 * is absent or not catalogued.
 *
 * Returning `null` rather than a generic sentence is deliberate: the caller
 * owns the fallback, and only the caller knows what it has left to show (a
 * `verifyError` from an older server, an HTTP status, nothing at all).
 *
 * @param code the machine code, typically `ApiError.code`
 * @param t    a translator scoped at the message ROOT — the catalogue keys are
 *   `errorHelp.<code>.what` / `.next`, and `<code>` itself contains a dot, so
 *   a namespaced translator would have to re-assemble the path anyway
 */
export function resolveErrorHelp(
  code: string | null | undefined,
  t: (key: string) => string,
): ErrorHelp | null {
  if (!isErrorHelpCode(code)) return null;
  const actionHref = ERROR_HELP_ACTIONS[code];
  return {
    what: t(`errorHelp.${code}.what`),
    next: t(`errorHelp.${code}.next`),
    ...(actionHref !== undefined ? { actionHref } : {}),
  };
}
