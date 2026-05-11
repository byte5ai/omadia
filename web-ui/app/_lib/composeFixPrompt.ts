/**
 * composeFixPrompt — frontend mirror of
 * middleware/src/plugins/builder/composeFixPrompt.ts (Option C, C-1).
 *
 * The web-ui side ships its own copy because:
 *   - The middleware helper imports server-only types (BuildError,
 *     ManifestViolation, ToolSmokeResult) that are not on the wire.
 *   - The frontend only sees the *projected* shapes from
 *     `_lib/builderTypes.ts` (BuildErrorRow with `file`/`column`,
 *     and the runtime-smoke result inline in build_status events).
 *
 * Output is byte-for-byte identical to the middleware helper so the
 * BuilderAgent's prompt parsing stays consistent regardless of whether
 * the prompt was composed by the operator (this file) or the backend
 * AutoFixOrchestrator (middleware file). If you change the wording, mirror
 * the change on both sides and bump the snapshot test on each.
 */

import type { BuildErrorRow } from './builderTypes';

const MAX_ITEMS = 5;
const CLOSER =
  'Fix bitte. Behalte alle Tools — kein silent removal. ' +
  'Wenn ein Tool wirklich raus muss, begründe es im Chat bevor du patchst.';

export interface SmokeToolResult {
  toolId: string;
  status: 'ok' | 'timeout' | 'threw' | 'validation_failed';
  durationMs: number;
  errorMessage?: string;
}

export type ComposeFixPromptInput =
  | {
      kind: 'build_failed';
      reason?: string;
      errors?: ReadonlyArray<BuildErrorRow>;
      buildN?: number;
    }
  | {
      kind: 'smoke_failed';
      smokeResults?: ReadonlyArray<SmokeToolResult>;
      buildN?: number;
    };

export function composeFixPrompt(input: ComposeFixPromptInput): string {
  switch (input.kind) {
    case 'build_failed':
      return formatBuildFailed(input);
    case 'smoke_failed':
      return formatSmokeFailed(input);
  }
}

function buildHeader(buildN: number | undefined, headline: string): string {
  const buildLabel =
    typeof buildN === 'number' ? `Build #${String(buildN)}` : 'Last build';
  return `**${buildLabel} failed:** ${headline}`;
}

function formatBuildFailed(
  input: Extract<ComposeFixPromptInput, { kind: 'build_failed' }>,
): string {
  const errors = input.errors ?? [];
  const reason =
    input.reason ?? (errors.length > 0 ? 'TypeScript compile errors' : 'unknown');
  const header = buildHeader(input.buildN, reason);

  if (errors.length === 0) {
    return [
      header,
      '',
      'No structured errors were captured. Inspect the build log and patch the slot.',
      '',
      CLOSER,
    ].join('\n');
  }

  const shown = errors.slice(0, MAX_ITEMS);
  const more = errors.length - shown.length;
  const lines = [header, '', 'Errors:'];
  for (const err of shown) {
    lines.push(
      `- \`${err.file}:${String(err.line)}:${String(err.column)}\` **${err.code}** — ${err.message}`,
    );
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
  const header = buildHeader(
    input.buildN,
    `runtime smoke test caught ${String(failed.length)} failing tool(s)`,
  );

  if (failed.length === 0) {
    return [
      header,
      '',
      'Smoke reported failure but no per-tool failure entries were attached.',
      '',
      CLOSER,
    ].join('\n');
  }

  const shown = failed.slice(0, MAX_ITEMS);
  const more = failed.length - shown.length;
  const lines = [header, '', 'Failing tools:'];
  for (const result of shown) {
    const msg = result.errorMessage?.trim() ?? '(no error message)';
    lines.push(
      `- **${result.toolId}** (\`${result.status}\`, ${String(result.durationMs)}ms) — ${msg}`,
    );
  }
  if (more > 0) {
    lines.push(`- _…and ${String(more)} more (capped at ${String(MAX_ITEMS)})._`);
  }
  lines.push('', CLOSER);
  return lines.join('\n');
}
