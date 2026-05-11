'use client';

import { Loader2, Play, Save, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { ApiError, runBuilderPreviewToolCall } from '../../../../_lib/api';
import type { ToolSpec } from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';
import {
  detectType,
  ensureTopLevelObject,
  type JsonSchemaNode,
  type SupportedType,
} from '../../../../_lib/jsonSchemaShape';

import { ToolTestResultPane } from './ToolTestResultPane';

interface ToolTestModalProps {
  draftId: string;
  tool: ToolSpec;
  onClose: () => void;
  /** B.11-6 hook (wired in next sub-commit). When provided, a "Save as
   *  test case" button promotes the most recent successful run into
   *  spec.test_cases[]. */
  onSaveTestCase?: (entry: {
    toolId: string;
    input: unknown;
    expected: unknown;
  }) => Promise<void> | void;
}

interface RunOutcome {
  result: unknown;
  isError: boolean;
  durationMs: number;
  input: unknown;
}

/**
 * B.11-5: Modal that lets the operator invoke `tool` directly against
 * the live preview-runtime with hand-crafted input, see the result, and
 * iterate. The form fields are generated from `tool.input` (top-level
 * object schema). Result/error rendering goes via ToolTestResultPane.
 */
export function ToolTestModal({
  draftId,
  tool,
  onClose,
  onSaveTestCase,
}: ToolTestModalProps): React.ReactElement {
  const schema = useMemo(() => ensureTopLevelObject(tool.input), [tool.input]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [pending, setPending] = useState<boolean>(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [savingTestCase, setSavingTestCase] = useState<boolean>(false);

  // Esc closes the modal — match the platform convention used elsewhere
  // (PreviewChatPane settings popover, install-diff modal).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onRun = useCallback(async () => {
    setPending(true);
    setRunError(null);
    setOutcome(null);
    try {
      const r = await runBuilderPreviewToolCall(draftId, tool.id, values);
      setOutcome({ ...r, input: values });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${String(err.status)}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unbekannter Fehler';
      setRunError(msg);
    } finally {
      setPending(false);
    }
  }, [draftId, tool.id, values]);

  const onSave = useCallback(async () => {
    if (!outcome || outcome.isError || !onSaveTestCase) return;
    setSavingTestCase(true);
    try {
      await onSaveTestCase({
        toolId: tool.id,
        input: outcome.input,
        expected: outcome.result,
      });
    } finally {
      setSavingTestCase(false);
    }
  }, [outcome, onSaveTestCase, tool.id]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Test ${tool.id}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--bg-soft)] px-4 py-2">
          <div>
            <h2 className="text-[13px] font-semibold text-[color:var(--fg-strong)]">
              Test <span className="font-mono-num">{tool.id}</span>
            </h2>
            <p className="text-[11px] text-[color:var(--fg-muted)]">
              Direkter Aufruf gegen die aktuelle Preview-Instanz.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Modal schließen"
            className="rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg)] hover:text-[color:var(--fg-strong)]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              Input
            </h3>
            <SchemaInputForm
              schema={schema}
              values={values}
              onChange={setValues}
            />
          </div>

          {runError ? (
            <div className="mt-3 rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 px-3 py-2 text-[11px] text-[color:var(--danger)]">
              {runError}
            </div>
          ) : null}

          {outcome ? (
            <div className="mt-3">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
                Ergebnis
              </h3>
              <ToolTestResultPane
                result={outcome.result}
                isError={outcome.isError}
                durationMs={outcome.durationMs}
              />
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-[color:var(--border)] bg-[color:var(--bg-soft)] px-4 py-2">
          <div className="text-[11px] text-[color:var(--fg-muted)]">
            Esc oder Klick außerhalb schließt das Modal.
          </div>
          <div className="flex items-center gap-2">
            {onSaveTestCase && outcome && !outcome.isError ? (
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={savingTestCase}
                className="inline-flex items-center gap-1 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)] disabled:opacity-50"
              >
                {savingTestCase ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <Save className="size-3" aria-hidden />
                )}
                Als Test-Case speichern
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded bg-[color:var(--accent)] px-3 py-1 text-[11px] font-semibold text-white shadow-[var(--shadow-cta)] disabled:opacity-50"
            >
              {pending ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <Play className="size-3" aria-hidden />
              )}
              Run
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchemaInputForm — generates input fields from a JSON-Schema object.
// Lightweight on purpose: only top-level object properties for primitives,
// enums, and arrays-of-primitives. Anything richer (nested objects, refs)
// surfaces a fallback Monaco-style note so the operator hand-crafts JSON
// in the IDE-side raw tab and pastes the value here.
// ---------------------------------------------------------------------------

function SchemaInputForm({
  schema,
  values,
  onChange,
}: {
  schema: JsonSchemaNode;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}): React.ReactElement {
  const props = (schema.properties as Record<string, JsonSchemaNode>) ?? {};
  const required = schema.required ?? [];
  const keys = Object.keys(props);

  if (keys.length === 0) {
    return (
      <p className="rounded border border-dashed border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-[11px] italic text-[color:var(--fg-muted)]">
        Tool akzeptiert leeres Input — Run drücken.
      </p>
    );
  }

  function setField(key: string, v: unknown): void {
    if (v === undefined) {
      const next = { ...values };
      delete next[key];
      onChange(next);
      return;
    }
    onChange({ ...values, [key]: v });
  }

  return (
    <div className="space-y-2">
      {keys.map((k) => {
        const propSchema = props[k] as JsonSchemaNode;
        const t = detectType(propSchema);
        const isReq = required.includes(k);
        return (
          <FieldByType
            key={k}
            fieldKey={k}
            type={t}
            schema={propSchema}
            required={isReq}
            value={values[k]}
            onChange={(v) => setField(k, v)}
          />
        );
      })}
    </div>
  );
}

function FieldByType({
  fieldKey,
  type,
  schema,
  required,
  value,
  onChange,
}: {
  fieldKey: string;
  type: SupportedType;
  schema: JsonSchemaNode;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.ReactElement {
  const id = useId();
  const fallbackText = useMemo(() => {
    if (value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const label = (
    <label
      htmlFor={id}
      className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
    >
      <span className="font-mono-num">{fieldKey}</span>
      {required ? (
        <span className="text-[color:var(--danger)]">*</span>
      ) : null}
      {schema.description ? (
        <span className="ml-1 truncate font-normal normal-case tracking-normal text-[color:var(--fg-muted)]">
          — {schema.description}
        </span>
      ) : null}
    </label>
  );

  if (type === 'string') {
    return (
      <div>
        {label}
        <input
          id={id}
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        />
      </div>
    );
  }
  if (type === 'number' || type === 'integer') {
    return (
      <div>
        {label}
        <input
          id={id}
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(undefined);
              return;
            }
            const num =
              type === 'integer' ? Number.parseInt(raw, 10) : Number(raw);
            if (Number.isFinite(num)) onChange(num);
          }}
          className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono-num text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        />
      </div>
    );
  }
  if (type === 'boolean') {
    return (
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-[11px] text-[color:var(--fg-strong)]"
      >
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-3"
        />
        <span className="font-mono-num">{fieldKey}</span>
        {required ? (
          <span className="text-[color:var(--danger)]">*</span>
        ) : null}
      </label>
    );
  }
  if (type === 'enum') {
    const options = (schema.enum ?? []).map((v) => String(v));
    return (
      <div>
        {label}
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={cn(
            'w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono-num text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none',
          )}
        >
          <option value="">— wählen —</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  // array / object — fall back to a small JSON textarea. Keeps the modal
  // useful for these shapes without a recursive form generator (Out-of-MVP).
  return (
    <div>
      {label}
      <textarea
        id={id}
        rows={3}
        defaultValue={fallbackText}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') {
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(raw));
          } catch {
            // leave as-is; user will see no commit
          }
        }}
        placeholder={
          type === 'array' ? '["a", "b"]' : '{"key": "value"}'
        }
        className="w-full resize-y rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono-num text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
      />
      <p className="mt-0.5 text-[10px] italic text-[color:var(--fg-muted)]">
        {type === 'array'
          ? 'Array — JSON-Syntax, blur committet.'
          : 'Object — JSON-Syntax, blur committet.'}
      </p>
    </div>
  );
}
