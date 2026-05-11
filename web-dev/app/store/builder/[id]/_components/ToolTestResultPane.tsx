'use client';

import { AlertCircle, CheckCircle2 } from 'lucide-react';

interface ToolTestResultPaneProps {
  result: unknown;
  isError: boolean;
  durationMs: number;
}

/**
 * B.11-5: Render output of a direct tool-call.
 *
 * Success → green checkmark, prettified JSON pretty-print of `result`.
 * Error → red banner with isError marker; if the result is a string we
 * show its tail (last ~30 lines) so the operator gets a stack trace
 * without scrolling indefinitely.
 */
export function ToolTestResultPane({
  result,
  isError,
  durationMs,
}: ToolTestResultPaneProps): React.ReactElement {
  const stringResult = typeof result === 'string' ? result : null;
  const display =
    stringResult ?? safeStringifyJson(result);
  const tail = isError && stringResult ? takeTail(stringResult, 30) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {isError ? (
            <>
              <AlertCircle className="size-3.5 text-[color:var(--danger)]" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--danger)]">
                Fehler
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 className="size-3.5 text-[color:var(--success,#16a34a)]" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-strong)]">
                Erfolg
              </span>
            </>
          )}
        </div>
        <span className="font-mono-num text-[10px] text-[color:var(--fg-muted)]">
          {`${durationMs.toFixed(0)} ms`}
        </span>
      </div>
      {tail ? (
        <pre className="max-h-64 overflow-auto rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 p-2 font-mono-num text-[11px] leading-snug text-[color:var(--danger)]">
          {tail}
        </pre>
      ) : (
        <pre className="max-h-64 overflow-auto rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-2 font-mono-num text-[11px] leading-snug text-[color:var(--fg-strong)]">
          {display}
        </pre>
      )}
    </div>
  );
}

function safeStringifyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function takeTail(text: string, lines: number): string {
  const split = text.split('\n');
  if (split.length <= lines) return text;
  return split.slice(-lines).join('\n');
}
