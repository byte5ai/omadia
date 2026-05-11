'use client';

import { Layers, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ToolSpec } from '../../../../_lib/builderTypes';
import {
  deletePersonalTemplate,
  listCuratedTemplates,
  listPersonalTemplates,
  type ToolTemplate,
} from '../../../../_lib/toolTemplates';

interface ToolTemplatesModalProps {
  /** Already-taken tool ids — used to dedupe the inserted id. */
  existingToolIds: ReadonlyArray<string>;
  onClose: () => void;
  onInsert: (tool: ToolSpec) => void;
}

/**
 * B.11-7: Catalog modal for inserting a fully-formed tool from a
 * curated or personal template. Personal templates show a "Mein"-Badge
 * and a delete control; curated entries are read-only.
 */
export function ToolTemplatesModal({
  existingToolIds,
  onClose,
  onInsert,
}: ToolTemplatesModalProps): React.ReactElement {
  const [personal, setPersonal] = useState<ReadonlyArray<ToolTemplate>>([]);
  const curated = listCuratedTemplates();

  useEffect(() => {
    setPersonal(listPersonalTemplates());
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all: ToolTemplate[] = [...personal, ...curated];

  function dedupedTool(tool: ToolSpec): ToolSpec {
    if (!existingToolIds.includes(tool.id)) return tool;
    let n = 2;
    let candidate = `${tool.id}_${String(n)}`;
    while (existingToolIds.includes(candidate)) {
      n += 1;
      candidate = `${tool.id}_${String(n)}`;
    }
    return { ...tool, id: candidate };
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tool-Templates"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[color:var(--border)] bg-[color:var(--bg-soft)] px-4 py-2">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-[color:var(--accent)]" aria-hidden />
            <h2 className="text-[13px] font-semibold text-[color:var(--fg-strong)]">
              Tool-Template wählen
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

        <div className="flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
          {all.length === 0 ? (
            <p className="rounded border border-dashed border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-4 text-center text-[12px] text-[color:var(--fg-muted)]">
              Keine Templates verfügbar.
            </p>
          ) : null}
          {all.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 hover:border-[color:var(--accent)]"
            >
              <button
                type="button"
                onClick={() => {
                  onInsert(dedupedTool(t.tool));
                  onClose();
                }}
                className="flex flex-1 flex-col items-start gap-0.5 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-[color:var(--fg-strong)]">
                    {t.label}
                  </span>
                  {t.source === 'personal' ? (
                    <span className="rounded bg-[color:var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent)]">
                      Mein
                    </span>
                  ) : null}
                </div>
                <span className="text-[11px] text-[color:var(--fg-muted)]">
                  {t.blurb}
                </span>
                <span className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
                  {t.tool.id}
                </span>
              </button>
              {t.source === 'personal' ? (
                <button
                  type="button"
                  onClick={() => {
                    deletePersonalTemplate(t.id);
                    setPersonal(listPersonalTemplates());
                  }}
                  aria-label={`Template ${t.label} löschen`}
                  className="rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)]"
                >
                  <Trash2 className="size-3" aria-hidden />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
