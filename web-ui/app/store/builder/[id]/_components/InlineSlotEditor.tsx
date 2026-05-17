'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';

import { patchBuilderSlot } from '../../../../_lib/api';
import { configureMonacoForBuilder } from './monacoBuilderConfig';

const MonacoEditor = dynamic(
  () => import('@monaco-editor/react').then((m) => m.default),
  { ssr: false },
);

interface InlineSlotEditorProps {
  draftId: string;
  slotKey: string;
  initialValue: string;
  /** Display label above the editor, e.g. "Component (TSX)". */
  label: string;
  /** One-line hint shown next to the label. */
  hint?: string;
  /** Editor height in px. Default 320. */
  heightPx?: number;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

const DEBOUNCE_MS = 800;

/**
 * B.12-Followup C — minimal Monaco-wrapped editor for inline slot editing
 * in PageForm. Smaller surface than SlotEditor: no slot-list, no template
 * warnings, no chat-prefill — just edit-debounce-save for one slot.
 *
 * Dirty-tracking: the editor seeds its value from `initialValue` on mount
 * and only re-seeds when slotKey changes (PageForm picks a different
 * page). External slot updates (e.g. BuilderAgent fills the slot via
 * chat) don't auto-mirror — collapsing + re-expanding the page row pulls
 * the fresh value. This trade-off keeps the implementation tight; the
 * global SlotEditor stays the authoritative path for slot-merge-conflict
 * scenarios.
 */
export function InlineSlotEditor({
  draftId,
  slotKey,
  initialValue,
  label,
  hint,
  heightPx = 320,
}: InlineSlotEditorProps): React.ReactElement {
  const [value, setValue] = useState<string>(initialValue);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed when slotKey changes (operator switched to a different page row).
  useEffect(() => {
    setValue(initialValue);
    setStatus({ kind: 'idle' });
  }, [slotKey, initialValue]);

  // Clear pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const flush = useCallback(
    async (source: string) => {
      setStatus({ kind: 'saving' });
      try {
        await patchBuilderSlot(draftId, slotKey, source);
        setStatus({ kind: 'saved' });
        setTimeout(() => {
          setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
        }, 1200);
      } catch (err) {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [draftId, slotKey],
  );

  const onChange = useCallback(
    (next: string | undefined) => {
      const text = next ?? '';
      setValue(text);
      setStatus({ kind: 'dirty' });
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void flush(text);
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  return (
    <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--bg-subtle)] px-3 py-1.5 text-[11px]">
        <span className="font-medium text-[color:var(--fg-strong)]">{label}</span>
        {hint ? <span className="text-[color:var(--fg-muted)]">{hint}</span> : null}
        <code className="ml-2 rounded bg-[color:var(--bg)] px-1.5 py-0.5 text-[10px] text-[color:var(--fg-muted)]">
          {slotKey}
        </code>
        <span className="ml-auto">
          <StatusBadge status={status} />
        </span>
      </div>
      <MonacoEditor
        height={`${String(heightPx)}px`}
        defaultLanguage="typescript"
        path={`${slotKey}.tsx`}
        value={value}
        onChange={onChange}
        theme="vs-dark"
        beforeMount={configureMonacoForBuilder}
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          tabSize: 2,
          lineNumbers: 'on',
          wordWrap: 'on',
          automaticLayout: true,
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: SaveStatus }): React.ReactElement | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'dirty':
      return <span className="text-amber-700">unsaved</span>;
    case 'saving':
      return <span className="text-[color:var(--fg-muted)]">saving…</span>;
    case 'saved':
      return <span className="text-emerald-700">saved</span>;
    case 'error':
      return (
        <span className="text-rose-700" title={status.message}>
          error
        </span>
      );
  }
}
