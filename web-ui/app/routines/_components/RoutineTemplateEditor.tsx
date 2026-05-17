'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  previewRoutineTemplate,
  setRoutineTemplate,
  type PreviewRoutineTemplateResponse,
  type RoutineDto,
  type RoutineOutputTemplateDto,
} from '../../_lib/api';

interface Props {
  routine: RoutineDto;
}

/**
 * Phase C.7 — Operator UI for authoring per-routine output templates.
 *
 * Surface lives inside the routine's expanded `DetailsPanel`. UX is
 * deliberately minimal for v1:
 *
 *   - JSON textarea editor (monospace) — the schema is small enough
 *     that hand-editing JSON is faster than building a structured form,
 *     and the operator sees the canonical shape they're persisting.
 *   - Live client-side JSON-parse to catch syntax errors before save;
 *     the server still validates the structure via
 *     `parseRoutineOutputTemplate` (defence in depth).
 *   - Synthetic-data preview pane: operator pastes raw tool result JSON
 *     and slot values, hits Preview, and sees the rendered markdown
 *     (or Adaptive Card body items for `adaptive-card` templates).
 *     No live-data replay in v1 — that's S-7.5 (receipt persistence).
 *   - "Speichern" persists via PUT, "Entfernen" clears (`template:null`),
 *     "Verwerfen" resets the draft to the persisted value.
 *
 * Side effects use `router.refresh()` so the server component re-fetches
 * and the rest of the row reflects the new template state.
 */
export function RoutineTemplateEditor({ routine }: Props): React.ReactElement {
  const router = useRouter();

  const persistedJson = useMemo(
    () =>
      routine.outputTemplate
        ? JSON.stringify(routine.outputTemplate, null, 2)
        : '',
    [routine.outputTemplate],
  );

  const [draft, setDraft] = useState<string>(persistedJson);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<boolean>(false);

  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const [previewRawJson, setPreviewRawJson] = useState<string>('{\n  \n}\n');
  const [previewSlotsJson, setPreviewSlotsJson] = useState<string>('{\n  \n}\n');
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] =
    useState<PreviewRoutineTemplateResponse | null>(null);

  // Detect client-side parse errors before the operator clicks Save.
  // Empty draft is a valid "clear template" state, not an error.
  const draftParseError = useMemo<string | null>(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return null;
    try {
      JSON.parse(trimmed);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [draft]);

  const dirty = draft !== persistedJson;

  async function handleSave(): Promise<void> {
    setSaveError(null);
    setSaveOk(false);
    let template: RoutineOutputTemplateDto | null = null;
    const trimmed = draft.trim();
    if (trimmed.length > 0) {
      try {
        template = JSON.parse(trimmed) as RoutineOutputTemplateDto;
      } catch (err) {
        setSaveError(
          err instanceof Error ? err.message : 'Invalid JSON syntax.',
        );
        return;
      }
    }
    setSaving(true);
    try {
      await setRoutineTemplate(routine.id, template);
      setSaveOk(true);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleReset(): void {
    setDraft(persistedJson);
    setSaveError(null);
    setSaveOk(false);
  }

  function handleClear(): void {
    setDraft('');
    setSaveError(null);
    setSaveOk(false);
  }

  async function handlePreview(): Promise<void> {
    setPreviewError(null);
    setPreviewResult(null);
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setPreviewError('Kein Template im Editor — kein Preview möglich.');
      return;
    }
    let template: RoutineOutputTemplateDto;
    try {
      template = JSON.parse(trimmed) as RoutineOutputTemplateDto;
    } catch (err) {
      setPreviewError(
        `Template-JSON kaputt: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    let rawToolResults: Record<string, unknown> = {};
    if (previewRawJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(previewRawJson) as unknown;
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          setPreviewError('rawToolResults muss ein JSON-Objekt sein.');
          return;
        }
        rawToolResults = parsed as Record<string, unknown>;
      } catch (err) {
        setPreviewError(
          `rawToolResults-JSON kaputt: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    let slots: Record<string, string> = {};
    if (previewSlotsJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(previewSlotsJson) as unknown;
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          setPreviewError('slots muss ein JSON-Objekt sein.');
          return;
        }
        slots = parsed as Record<string, string>;
      } catch (err) {
        setPreviewError(
          `slots-JSON kaputt: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
    setPreviewLoading(true);
    try {
      const result = await previewRoutineTemplate({
        template,
        rawToolResults,
        slots,
      });
      setPreviewResult(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          Output Template
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
          {routine.outputTemplate ? (
            <span className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 px-2 py-0.5 font-semibold text-[color:var(--accent)]">
              aktiv · {routine.outputTemplate.format}
            </span>
          ) : (
            <span className="rounded-full border border-[color:var(--border)] px-2 py-0.5 font-semibold text-[color:var(--fg-muted)]">
              legacy LLM-renders
            </span>
          )}
        </div>
      </div>

      <p className="text-[12px] leading-relaxed text-[color:var(--fg-muted)]">
        JSON-Schema:{' '}
        <code className="font-mono text-[11px]">
          {`{ format, sections: [...] }`}
        </code>
        . Beim Trigger rendert der Server alle data- + static-Sektionen
        selbst; der LLM füllt nur die narrative-slot-Strings. Leerer Editor
        = Template entfernen, Routine läuft wieder im Legacy-Pfad.
      </p>

      <textarea
        value={draft}
        onChange={(e): void => {
          setDraft(e.target.value);
          setSaveOk(false);
        }}
        spellCheck={false}
        rows={16}
        className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-3 font-mono text-[12px] leading-relaxed text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        placeholder='{ "format": "markdown", "sections": [ { "kind": "narrative-slot", "id": "intro", "hint": "Ein Satz Einleitung." } ] }'
      />

      {draftParseError ? (
        <div className="rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/5 p-2 text-[11px] text-[color:var(--warn)]">
          <span className="font-semibold">JSON syntax:</span>{' '}
          <span className="font-mono">{draftParseError}</span>
        </div>
      ) : null}

      {saveError ? (
        <div className="rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-2 text-[11px] text-[color:var(--danger)]">
          <span className="font-semibold">Save fehlgeschlagen:</span>{' '}
          <span className="font-mono">{saveError}</span>
        </div>
      ) : null}

      {saveOk ? (
        <div className="rounded-md border border-[color:var(--ok)]/40 bg-[color:var(--ok)]/5 p-2 text-[11px] text-[color:var(--ok)]">
          Gespeichert.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={(): void => {
            void handleSave();
          }}
          disabled={saving || draftParseError !== null || !dirty}
          className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--accent)] transition hover:border-[color:var(--accent)] disabled:opacity-40"
        >
          {saving ? 'Speichert…' : 'Speichern'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={saving || !dirty}
          className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--fg-strong)] disabled:opacity-40"
        >
          Verwerfen
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={saving || draft.trim().length === 0}
          className="rounded-full border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--warn)] transition hover:border-[color:var(--warn)] disabled:opacity-40"
        >
          Editor leeren
        </button>

        <span className="ml-auto" />

        <button
          type="button"
          onClick={(): void => setPreviewOpen((v) => !v)}
          className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--fg-strong)]"
          aria-expanded={previewOpen}
        >
          {previewOpen ? 'Preview schließen' : 'Preview öffnen'}
        </button>
      </div>

      {previewOpen ? (
        <div className="space-y-3 rounded-md border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
            Preview mit synthetischen Daten
          </div>
          <p className="text-[11px] leading-relaxed text-[color:var(--fg-muted)]">
            Server-side Render-Preview ohne LLM-Call. Du gibst die
            tool-Ergebnisse + Slot-Werte vor, die der Renderer normalerweise
            zur Trigger-Zeit aus C.2 + C.3 bekommt.
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor={`preview-raw-${routine.id}`}
                className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]"
              >
                rawToolResults · per Tool-Name
              </label>
              <textarea
                id={`preview-raw-${routine.id}`}
                value={previewRawJson}
                onChange={(e): void => setPreviewRawJson(e.target.value)}
                spellCheck={false}
                rows={10}
                className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-2 font-mono text-[11px] leading-relaxed text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
                placeholder='{\n  "query_odoo_hr": { "absences": [{ "name": "Anna" }] }\n}'
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={`preview-slots-${routine.id}`}
                className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]"
              >
                slots · LLM-Narrative
              </label>
              <textarea
                id={`preview-slots-${routine.id}`}
                value={previewSlotsJson}
                onChange={(e): void => setPreviewSlotsJson(e.target.value)}
                spellCheck={false}
                rows={10}
                className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-2 font-mono text-[11px] leading-relaxed text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
                placeholder='{\n  "intro": "Heute eine Person abwesend."\n}'
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(): void => {
                void handlePreview();
              }}
              disabled={previewLoading}
              className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--accent)] transition hover:border-[color:var(--accent)] disabled:opacity-40"
            >
              {previewLoading ? 'Rendert…' : 'Preview'}
            </button>
          </div>
          {previewError ? (
            <div className="rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-2 text-[11px] text-[color:var(--danger)]">
              <span className="font-mono">{previewError}</span>
            </div>
          ) : null}
          {previewResult ? (
            <PreviewOutput result={previewResult} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewOutput({
  result,
}: {
  result: PreviewRoutineTemplateResponse;
}): React.ReactElement {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/5 p-3 text-[11px] text-[color:var(--warn)]">
        <span className="font-semibold">Renderer abgelehnt:</span>{' '}
        <span className="font-mono">{result.reason}</span>
      </div>
    );
  }
  if (result.format === 'markdown') {
    return (
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ok)]">
          rendered markdown ({result.text.length} chars)
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3 font-mono text-[11px] leading-relaxed text-[color:var(--fg-strong)]">
          {result.text}
        </pre>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ok)]">
        rendered adaptive-card body ({result.items.length} items)
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] p-3 font-mono text-[11px] leading-relaxed text-[color:var(--fg-strong)]">
        {JSON.stringify(result.items, null, 2)}
      </pre>
    </div>
  );
}
