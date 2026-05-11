'use client';

import dynamic from 'next/dynamic';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const MonacoEditor = dynamic(
  () => import('@monaco-editor/react').then((m) => m.default),
  { ssr: false },
);

interface ToolInputSchemaJsonTabProps {
  /** Current schema (may be undefined for fresh tools). */
  value: Record<string, unknown> | undefined;
  /** Called when the JSON parses cleanly. The form view re-renders against
   *  the new value; unsupported patterns there fall back to read-only. */
  onChange: (next: Record<string, unknown>) => void;
}

/**
 * B.11-4: Raw-JSON tab for the Tool input schema.
 *
 * Direct Monaco JSON editor over the shape. On every edit we attempt
 * to parse — successful parses immediately propagate to the parent
 * (which re-renders the form view); failed parses keep the user's
 * draft visible with a red banner so they can fix the syntax without
 * losing their typing.
 */
export function ToolInputSchemaJsonTab({
  value,
  onChange,
}: ToolInputSchemaJsonTabProps): React.ReactElement {
  const initial = useMemo(
    () => JSON.stringify(value ?? {}, null, 2),
    [value],
  );
  const [text, setText] = useState<string>(initial);
  const [parseError, setParseError] = useState<string | null>(null);

  // When the parent value changes (via Form-tab edits or SSE refetch),
  // sync the editor text. Skip if our local text already JSON-stringifies
  // to the same shape — otherwise we'd clobber the cursor mid-edit.
  if (text !== initial) {
    try {
      const ours = JSON.parse(text) as unknown;
      if (JSON.stringify(ours) !== JSON.stringify(value ?? {})) {
        // Only resync if we don't have a pending unsaved diff.
        if (parseError === null && initial !== text) {
          setText(initial);
        }
      }
    } catch {
      // unparseable local edit — leave it alone
    }
  }

  const onEditorChange = useCallback(
    (next: string | undefined) => {
      const v = next ?? '';
      setText(v);
      try {
        const parsed = JSON.parse(v) as unknown;
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          setParseError('Top-level muss ein Objekt sein.');
          return;
        }
        setParseError(null);
        onChange(parsed as Record<string, unknown>);
      } catch (err) {
        setParseError(
          err instanceof Error ? err.message : 'JSON-Parse-Fehler',
        );
      }
    },
    [onChange],
  );

  return (
    <div className="space-y-1.5">
      <div className="overflow-hidden rounded-md border border-[color:var(--border)]">
        <MonacoEditor
          height="240px"
          language="json"
          theme="vs-dark"
          value={text}
          onChange={onEditorChange}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
          }}
        />
      </div>
      {parseError ? (
        <div className="flex items-start gap-1 rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 px-2 py-1 text-[11px] text-[color:var(--danger)]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="break-words">{parseError}</span>
        </div>
      ) : null}
      <p className="text-[10px] italic text-[color:var(--fg-muted)]">
        Direkter JSON-Schema-Modus. Beim Wechsel zur Formular-Ansicht werden
        nicht-unterstützte Patterns (oneOf, $ref, polymorphic) read-only.
      </p>
    </div>
  );
}
