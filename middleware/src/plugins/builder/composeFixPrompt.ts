/**
 * composeFixPrompt — pure helper that turns a build/smoke/manifest
 * failure into a Markdown user-message the BuilderAgent can act on.
 *
 * Used in two paths (Option C, AutoFix-Loop):
 *   - C-2: "Fix mit Builder"-Button pre-fills the chat input with the
 *     output of this helper; the operator confirms and sends.
 *   - C-4: AutoFixOrchestrator fires a synthetic builder-turn with the
 *     same string when `spec.builder_settings.auto_fix_enabled === true`.
 *
 * Shape contract:
 *   - Discriminated union on `kind`. Each kind formats the relevant
 *     payload; missing payloads degrade gracefully (header-only).
 *   - Errors / violations / smoke-results are capped at 5; an "and N
 *     more" line is appended when truncation happens.
 *   - Every prompt closes with the Content-Guard reminder
 *     ("Behalte alle Tools — kein silent removal."). The Content-Guard
 *     itself runs server-side at fill_slot/patch_spec — this string is
 *     a hint to nudge the agent away from removal-as-a-fix.
 *
 * No I/O, no side effects — the result is purely a function of inputs.
 */

import type { BuildError } from './buildErrorParser.js';
import type { ManifestViolation } from './manifestLinter.js';
import type {
  AdminRouteSmokeResult,
  ToolSmokeResult,
  UiRouteSmokeResult,
} from './runtimeSmoke.js';

const MAX_ITEMS = 5;
const CLOSER =
  'Fix bitte. Behalte alle Tools — kein silent removal. ' +
  'Wenn ein Tool wirklich raus muss, begründe es im Chat bevor du patchst.';

export type ComposeFixPromptInput =
  | {
      kind: 'build_failed';
      reason?: string;
      errors?: ReadonlyArray<BuildError>;
      buildN?: number;
    }
  | {
      kind: 'smoke_failed';
      smokeResults?: ReadonlyArray<ToolSmokeResult>;
      buildN?: number;
    }
  | {
      kind: 'manifest_violations';
      violations?: ReadonlyArray<ManifestViolation>;
      buildN?: number;
    }
  | {
      kind: 'admin_route_schema_violation';
      adminRouteResults?: ReadonlyArray<AdminRouteSmokeResult>;
      buildN?: number;
    }
  | {
      kind: 'ui_route_render_failed';
      uiRouteResults?: ReadonlyArray<UiRouteSmokeResult>;
      buildN?: number;
    };

export function composeFixPrompt(input: ComposeFixPromptInput): string {
  switch (input.kind) {
    case 'build_failed':
      return formatBuildFailed(input);
    case 'smoke_failed':
      return formatSmokeFailed(input);
    case 'manifest_violations':
      return formatManifestViolations(input);
    case 'admin_route_schema_violation':
      return formatAdminRouteSchemaViolation(input);
    case 'ui_route_render_failed':
      return formatUiRouteRenderFailed(input);
  }
}

function buildHeader(buildN: number | undefined, headline: string): string {
  const buildLabel = typeof buildN === 'number' ? `Build #${String(buildN)}` : 'Last build';
  return `**${buildLabel} failed:** ${headline}`;
}

function formatBuildFailed(
  input: Extract<ComposeFixPromptInput, { kind: 'build_failed' }>,
): string {
  const errors = input.errors ?? [];
  const reason = input.reason ?? (errors.length > 0 ? 'TypeScript compile errors' : 'unknown');
  const header = buildHeader(input.buildN, reason);

  if (errors.length === 0) {
    return [header, '', 'No structured errors were captured. Inspect the build log and patch the slot.', '', CLOSER].join('\n');
  }

  const shown = errors.slice(0, MAX_ITEMS);
  const more = errors.length - shown.length;
  const lines = [header, '', 'Errors:'];
  for (const err of shown) {
    lines.push(`- \`${err.path}:${String(err.line)}:${String(err.col)}\` **${err.code}** — ${err.message}`);
  }
  if (more > 0) {
    lines.push(`- _…and ${String(more)} more (capped at ${String(MAX_ITEMS)})._`);
  }
  lines.push('', CLOSER);
  return lines.join('\n');
}

function formatSmokeFailed(
  input: Extract<ComposeFixPromptInput, { kind: 'smoke_failed' }>,
): string {
  const all = input.smokeResults ?? [];
  const failed = all.filter((r) => r.status !== 'ok');
  const header = buildHeader(input.buildN, `runtime smoke test caught ${String(failed.length)} failing tool(s)`);

  if (failed.length === 0) {
    return [header, '', 'Smoke reported failure but no per-tool failure entries were attached.', '', CLOSER].join('\n');
  }

  const shown = failed.slice(0, MAX_ITEMS);
  const more = failed.length - shown.length;
  const lines = [header, '', 'Failing tools:'];
  for (const result of shown) {
    const msg = result.errorMessage?.trim() ?? '(no error message)';
    lines.push(`- **${result.toolId}** (\`${result.status}\`, ${String(result.durationMs)}ms) — ${msg}`);
  }
  if (more > 0) {
    lines.push(`- _…and ${String(more)} more (capped at ${String(MAX_ITEMS)})._`);
  }
  lines.push('', CLOSER);
  return lines.join('\n');
}

function formatAdminRouteSchemaViolation(
  input: Extract<
    ComposeFixPromptInput,
    { kind: 'admin_route_schema_violation' }
  >,
): string {
  const all = input.adminRouteResults ?? [];
  const failed = all.filter(
    (r) =>
      r.status === 'schema_violation' ||
      r.status === 'http_error' ||
      r.status === 'timeout',
  );
  const header = buildHeader(
    input.buildN,
    `admin-route smoke caught ${String(failed.length)} schema/HTTP violation(s)`,
  );

  if (failed.length === 0) {
    return [
      header,
      '',
      'Admin-route smoke reported failure but no per-route entries were attached.',
      '',
      CLOSER,
    ].join('\n');
  }

  const shown = failed.slice(0, MAX_ITEMS);
  const more = failed.length - shown.length;
  const lines = [
    header,
    '',
    'Admin-routes must respond `{ ok: boolean, ... }` (success → `{ ok: true, items: [...] }`, failure → `{ ok: false, error: "<msg>" }`). The Frontend prüft `data.ok` — fehlt das Feld, sieht es jeden Erfolg als Fehler.',
    '',
    'Failing endpoints:',
  ];
  for (const result of shown) {
    const reason = result.reason?.trim() ?? '(no reason)';
    const httpPart =
      result.httpStatus !== undefined ? ` HTTP ${String(result.httpStatus)}` : '';
    lines.push(
      `- \`GET ${result.endpoint}\` (\`${result.status}\`${httpPart}, ${String(result.durationMs)}ms) — ${reason}`,
    );
  }
  if (more > 0) {
    lines.push(`- _…and ${String(more)} more (capped at ${String(MAX_ITEMS)})._`);
  }
  lines.push('', CLOSER);
  return lines.join('\n');
}

function formatUiRouteRenderFailed(
  input: Extract<ComposeFixPromptInput, { kind: 'ui_route_render_failed' }>,
): string {
  const all = input.uiRouteResults ?? [];
  const failed = all.filter((r) => r.status !== 'ok' && r.status !== 'introspection_failed');
  const header = buildHeader(
    input.buildN,
    `ui-route smoke caught ${String(failed.length)} render failure(s)`,
  );

  if (failed.length === 0) {
    return [
      header,
      '',
      'UI-route smoke reported failure but no per-route entries were attached.',
      '',
      CLOSER,
    ].join('\n');
  }

  const shown = failed.slice(0, MAX_ITEMS);
  const more = failed.length - shown.length;
  const lines = [
    header,
    '',
    'UI-routes (Dashboard-Tabs) müssen rendern: 2xx-Status, `Content-Type: text/html`, ' +
      "`Content-Security-Policy` mit `frame-ancestors` (Teams-Iframe-Embedding), und einen " +
      'nicht-leeren Body. Wer das nicht erfüllt, wird vom Hub als kaputt geflagged.',
    '',
    'Häufigste Failure-Modes:',
    '- `missing_csp`: setze CSP via `renderRoute()` aus `@omadia/plugin-ui-helpers` — der Helper macht das automatisch.',
    '- `wrong_content_type`: `res.json(...)` statt `res.send(html)` aufgerufen. Library-/free-form-Modus muss HTML zurückgeben.',
    '- `empty_render`: Component wirft beim SSR, oder die Daten-Fetch-Logik throws + es gibt keinen errorBanner-Fallback.',
    '',
    'Failing ui-routes:',
  ];
  for (const result of shown) {
    const reason = result.reason?.trim() ?? '(no reason)';
    const httpPart =
      result.httpStatus !== undefined ? ` HTTP ${String(result.httpStatus)}` : '';
    lines.push(
      `- \`GET ${result.endpoint}\` (\`${result.status}\`${httpPart}, ${String(result.durationMs)}ms) — ${reason}`,
    );
  }
  if (more > 0) {
    lines.push(`- _…and ${String(more)} more (capped at ${String(MAX_ITEMS)})._`);
  }
  lines.push('', CLOSER);
  return lines.join('\n');
}

function formatManifestViolations(
  input: Extract<ComposeFixPromptInput, { kind: 'manifest_violations' }>,
): string {
  const violations = input.violations ?? [];
  const header = buildHeader(input.buildN, `${String(violations.length)} manifest violation(s)`);

  if (violations.length === 0) {
    return [header, '', 'Manifest linter reported failure but no violations were attached.', '', CLOSER].join('\n');
  }

  const shown = violations.slice(0, MAX_ITEMS);
  const more = violations.length - shown.length;
  const lines = [header, '', 'Violations:'];
  for (const v of shown) {
    lines.push(`- \`${v.path}\` _${v.kind}_ — ${v.message}`);
  }
  if (more > 0) {
    lines.push(`- _…and ${String(more)} more (capped at ${String(MAX_ITEMS)})._`);
  }
  lines.push('', CLOSER);
  return lines.join('\n');
}
