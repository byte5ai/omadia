'use client';

import { AlertTriangle, Check, Loader2, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { JsonPatch, ToolSpec } from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';
import {
  mapJsonSchemaArray,
  mapOpenAPI,
  type ImportError,
  type ImportResult,
} from '../../../../_lib/openapiToTools';

interface ToolBulkImportModalProps {
  existingToolIds: ReadonlyArray<string>;
  onClose: () => void;
  onImport: (patches: JsonPatch[]) => Promise<void> | void;
}

/**
 * B.11-8: Modal for pasting OpenAPI 3 (yaml or json) or a JSON-Schema
 * array. Shows a diff-preview table (id + description + collision
 * marker) and on confirm fires N atomic JSON-Patches against
 * spec.tools.
 */
export function ToolBulkImportModal({
  existingToolIds,
  onClose,
  onImport,
}: ToolBulkImportModalProps): React.ReactElement {
  const [tab, setTab] = useState<'openapi' | 'jsonschema'>('openapi');
  const [text, setText] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);

  const result = useMemo<ImportResult | null>(() => {
    if (!text.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try YAML — fall through to whatever the JSON parser gave us.
      // We don't pull a YAML lib here; OpenAPI 3 in JSON form is the
      // most common copy/paste source from Postman/Swagger UI.
      return {
        tools: [],
        errors: [
          {
            path: '<root>',
            reason: 'Eingabe ist kein gültiges JSON. YAML wird im B.11+ Cleanup unterstützt.',
          },
        ],
      };
    }
    return tab === 'openapi' ? mapOpenAPI(parsed) : mapJsonSchemaArray(parsed);
  }, [tab, text]);

  const collisions: ReadonlyArray<string> = useMemo(() => {
    if (!result) return [];
    return result.tools
      .filter((t) => existingToolIds.includes(t.id))
      .map((t) => t.id);
  }, [result, existingToolIds]);

  async function onConfirm(): Promise<void> {
    if (!result || result.tools.length === 0) return;
    const patches: JsonPatch[] = result.tools
      .filter((t) => !existingToolIds.includes(t.id))
      .map((tool) => ({
        op: 'add' as const,
        path: '/tools/-',
        value: tool,
      }));
    if (patches.length === 0) return;
    setPending(true);
    try {
      await onImport(patches);
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tools-Bulk-Import"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--bg-soft)] px-4 py-2">
          <div className="flex items-center gap-2">
            <Upload className="size-4 text-[color:var(--accent)]" aria-hidden />
            <h2 className="text-[13px] font-semibold text-[color:var(--fg-strong)]">
              Tools importieren
            </h2>
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

        <div className="flex items-center gap-1 border-b border-[color:var(--border)] bg-[color:var(--bg-soft)] px-4 pb-2">
          <TabBtn active={tab === 'openapi'} onClick={() => setTab('openapi')}>
            OpenAPI 3 (JSON)
          </TabBtn>
          <TabBtn
            active={tab === 'jsonschema'}
            onClick={() => setTab('jsonschema')}
          >
            JSON-Schema-Array
          </TabBtn>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-3 overflow-hidden px-4 py-3">
          <div className="flex min-h-0 flex-col">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              Eingabe
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                tab === 'openapi'
                  ? '{ "openapi": "3.0.3", "paths": { ... } }'
                  : '[{ "id": "...", "description": "...", "input": { ... } }]'
              }
              className="h-full min-h-0 w-full resize-none rounded border border-[color:var(--border)] bg-[color:var(--bg)] p-2 font-mono-num text-[11px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
              spellCheck={false}
            />
          </div>
          <div className="flex min-h-0 flex-col">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              Vorschau
            </span>
            <div className="flex-1 overflow-y-auto rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-2">
              <PreviewPane
                result={result}
                collisions={collisions}
                existingToolIds={existingToolIds}
              />
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-[color:var(--border)] bg-[color:var(--bg-soft)] px-4 py-2">
          <p className="text-[11px] text-[color:var(--fg-muted)]">
            Kollisionen werden übersprungen — bestehende Tools bleiben unverändert.
          </p>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={
              pending ||
              !result ||
              result.tools.length === 0 ||
              result.tools.length === collisions.length
            }
            className="inline-flex items-center gap-1 rounded bg-[color:var(--accent)] px-3 py-1 text-[11px] font-semibold text-white shadow-[var(--shadow-cta)] disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Check className="size-3" aria-hidden />
            )}
            Import bestätigen
          </button>
        </footer>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-t border-x border-t px-3 py-1.5 text-[11px] font-semibold',
        active
          ? 'border-[color:var(--border)] bg-[color:var(--bg)] text-[color:var(--fg-strong)]'
          : 'border-transparent text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-strong)]',
      )}
    >
      {children}
    </button>
  );
}

function PreviewPane({
  result,
  collisions,
  existingToolIds,
}: {
  result: ImportResult | null;
  collisions: ReadonlyArray<string>;
  existingToolIds: ReadonlyArray<string>;
}): React.ReactElement {
  if (!result) {
    return (
      <p className="text-[11px] italic text-[color:var(--fg-muted)]">
        Eingabe einfügen, um die Vorschau zu sehen.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[color:var(--fg-strong)]">
        {String(result.tools.length)} Tools erkannt
        {collisions.length > 0
          ? `, ${String(collisions.length)} Kollisionen`
          : ''}
        {result.errors.length > 0
          ? `, ${String(result.errors.length)} Fehler`
          : ''}
        .
      </p>
      {result.tools.length > 0 ? (
        <ul className="space-y-1">
          {result.tools.map((t: ToolSpec) => {
            const collide = existingToolIds.includes(t.id);
            return (
              <li
                key={t.id}
                className={cn(
                  'rounded border px-2 py-1',
                  collide
                    ? 'border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8'
                    : 'border-[color:var(--border)] bg-[color:var(--bg)]',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono-num text-[11px] text-[color:var(--fg-strong)]">
                    {t.id}
                  </span>
                  {collide ? (
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--warning)]">
                      Kollision
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-[10px] text-[color:var(--fg-muted)]">
                  {t.description}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {result.errors.length > 0 ? (
        <ul className="space-y-1">
          {result.errors.map((e: ImportError, i) => (
            <li
              key={`${e.path}-${String(i)}`}
              className="flex items-start gap-1 rounded border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 px-2 py-1 text-[11px] text-[color:var(--danger)]"
            >
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                <span className="font-mono-num">{e.path}</span> — {e.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
