'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import dynamic from 'next/dynamic';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CircleDashed,
  CircleDot,
  FileCode2,
  Loader2,
  Save,
  Sparkles,
} from 'lucide-react';

import { ApiError, getDraftLibs, patchBuilderSlot } from '../../../../_lib/api';
import type {
  BuilderLib,
  BuildErrorRow,
  TemplateSlotDef,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

// Monaco's editor bundles client-only code (web workers, requestAnimationFrame
// hooks). Dynamic-import with `ssr: false` keeps it out of the server bundle
// and avoids hydration mismatches.
const MonacoEditor = dynamic(
  () => import('@monaco-editor/react').then((m) => m.default),
  { ssr: false },
);

interface SlotEditorProps {
  draftId: string;
  /** Server-canonical slot map. The editor mirrors this whenever the user
   *  is not actively typing into the matching slot. */
  slots: Record<string, string>;
  /** Boilerplate-template slot manifest. The Workspace fetches this once
   *  and shares the result with both the per-tab warning badge logic and
   *  this editor — saves a duplicate /template/slots round-trip. */
  templateSlots: ReadonlyArray<TemplateSlotDef>;
  /** Optional bridge to the BuilderChatPane: sets the chat input to a
   *  pre-filled prompt so the user can ask the agent to fill a missing
   *  slot in one click. With `autoSubmit: true` the turn fires
   *  immediately. The Workspace owns the actual input state. */
  onPrefillBuilderChat?: (
    prompt: string,
    opts?: { autoSubmit?: boolean },
  ) => void;
  /** Latest tsc diagnostics from the most recent build (B.6-13.2). The
   *  editor filters them by the active slot's `target_file` and renders
   *  Monaco gutter markers on the matching lines so the operator sees
   *  the failure inline instead of having to leave the editor for the
   *  Preview pane error list. */
  buildErrors?: ReadonlyArray<BuildErrorRow>;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saved' }
  | { kind: 'dirty' }
  | { kind: 'error'; message: string };

const DEBOUNCE_MS = 800;
const LANGUAGE = 'typescript';

/**
 * Slot-Editor (Phase B.5-6).
 *
 * Monaco-backed editor for one slot at a time. On the wire, slots are
 * `{ [slotKey: string]: string }` — TypeScript source the boilerplate
 * compiles into the agent. The editor:
 *
 *   - keeps the active slot's text in a `dirty` ref so a server-driven
 *     re-fetch (SSE → Workspace) doesn't clobber what the user is typing,
 *   - debounces writes (800 ms after last keystroke) into
 *     `PATCH /drafts/:id/slot`,
 *   - supports Cmd/Ctrl+S to flush the debounce immediately,
 *   - falls back to a plain textarea while Monaco is loading so the pane
 *     never shows a blank rectangle.
 *
 * Type-aware editing: the host turns on Monaco's TypeScript service with
 * a permissive set of compiler options (no strict, no no-implicit-any) so
 * a pre-existing slot file with loose typing still feels usable. Loading
 * boilerplate `.d.ts` files for full LSP-level auto-complete is a B.6+
 * concern — for now we get syntax highlighting, fold/format, and the
 * built-in lib.es2022 typings.
 */
export function SlotEditor({
  draftId,
  slots,
  templateSlots,
  onPrefillBuilderChat,
  buildErrors = [],
}: SlotEditorProps): React.ReactElement {
  const slotKeys = useMemo(() => Object.keys(slots).sort(), [slots]);
  const [active, setActive] = useState<string>(() => slotKeys[0] ?? '');
  const [draft, setDraft] = useState<string>(() =>
    slotKeys[0] ? (slots[slotKeys[0]] ?? '') : '',
  );
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const debounceRef = useRef<number | null>(null);
  const draftRef = useRef(draft);
  const lastSavedRef = useRef<string>(slotKeys[0] ? (slots[slotKeys[0]] ?? '') : '');
  const selectId = useId();
  draftRef.current = draft;

  // Switch to the first slot when the slot list changes from empty → non-
  // empty (initial load) or shrinks below the current selection.
  useEffect(() => {
    if (active && slotKeys.includes(active)) return;
    const next = slotKeys[0] ?? '';
    setActive(next);
    const value = next ? (slots[next] ?? '') : '';
    setDraft(value);
    lastSavedRef.current = value;
    setStatus({ kind: 'idle' });
  }, [slotKeys, active, slots]);

  // When the server-canonical value of the ACTIVE slot changes (e.g. a
  // sibling tab edited it, or the BuilderAgent's fill_slot tool wrote it),
  // and the user has no in-flight dirty edit, mirror the new value.
  useEffect(() => {
    if (!active) return;
    const canonical = slots[active] ?? '';
    if (canonical === lastSavedRef.current) return;
    lastSavedRef.current = canonical;
    if (status.kind !== 'dirty' && status.kind !== 'pending') {
      setDraft(canonical);
    }
  }, [active, slots, status.kind]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);


  const flush = useCallback(async () => {
    if (!active) return;
    const next = draftRef.current;
    if (next === lastSavedRef.current) {
      setStatus({ kind: 'idle' });
      return;
    }
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setStatus({ kind: 'pending' });
    try {
      await patchBuilderSlot(draftId, active, next);
      lastSavedRef.current = next;
      setStatus({ kind: 'saved' });
      window.setTimeout(() => {
        setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
      }, 1200);
    } catch (err) {
      setStatus({ kind: 'error', message: humanizeApiError(err) });
    }
  }, [active, draftId]);

  const onChange = useCallback(
    (value: string | undefined) => {
      const next = value ?? '';
      setDraft(next);
      setStatus({ kind: 'dirty' });
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  const onSelectSlot = useCallback(
    (key: string) => {
      // If we have unsaved edits in the current slot, flush them before
      // switching so the new selection's view is clean.
      void flush().finally(() => {
        setActive(key);
        const next = slots[key] ?? '';
        setDraft(next);
        lastSavedRef.current = next;
        setStatus({ kind: 'idle' });
      });
    },
    [flush, slots],
  );

  // B.6-11: per-draft Monaco lib bundle. Fetched once on draft change;
  // applied via addExtraLib inside onMonacoMount AND re-applied via a
  // useEffect when libs land after Monaco has already mounted (race-safe).
  const [libs, setLibs] = useState<BuilderLib[]>([]);
  const monacoRef = useRef<unknown>(null);
  // Editor instance ref for setModelMarkers (B.6-13.2).
  const editorRef = useRef<unknown>(null);
  useEffect(() => {
    let alive = true;
    void getDraftLibs(draftId)
      .then((res) => {
        if (alive) setLibs(res.libs);
      })
      .catch(() => {
        // Non-fatal — Cmd+Click + autocomplete just won't work.
      });
    return () => {
      alive = false;
    };
  }, [draftId]);

  const applyLibs = useCallback((monaco: unknown, items: BuilderLib[]): void => {
    interface MonacoLibsNS {
      languages: {
        typescript: {
          typescriptDefaults: {
            addExtraLib: (content: string, filePath: string) => void;
          };
        };
      };
    }
    const m = monaco as MonacoLibsNS;
    for (const lib of items) {
      m.languages.typescript.typescriptDefaults.addExtraLib(
        lib.content,
        lib.path,
      );
    }
  }, []);

  useEffect(() => {
    if (libs.length === 0 || !monacoRef.current) return;
    applyLibs(monacoRef.current, libs);
  }, [libs, applyLibs]);

  const onMonacoMount = useCallback((editor: unknown, monaco: unknown) => {
    interface MonacoNS {
      languages: {
        typescript: {
          typescriptDefaults: {
            setCompilerOptions: (opts: Record<string, unknown>) => void;
            setDiagnosticsOptions: (opts: Record<string, unknown>) => void;
          };
          ScriptTarget: { ES2022: number };
          ModuleKind: { ESNext: number };
          ModuleResolutionKind: { NodeJs: number };
          JsxEmit: { Preserve: number };
        };
      };
      KeyMod: { CtrlCmd: number };
      KeyCode: { KeyS: number };
    }
    interface MonacoEditorNS {
      addCommand: (key: number, handler: () => void) => void;
    }
    const m = monaco as MonacoNS;
    const ed = editor as MonacoEditorNS;
    m.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: m.languages.typescript.ScriptTarget.ES2022,
      module: m.languages.typescript.ModuleKind.ESNext,
      moduleResolution: m.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: m.languages.typescript.JsxEmit.Preserve,
      strict: false,
      noImplicitAny: false,
      esModuleInterop: true,
      allowJs: true,
      skipLibCheck: true,
    });
    m.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
      void flush();
    });
    // Stash the monaco instance so the libs-arrived useEffect can call
    // addExtraLib if the fetch resolved before the editor mounted.
    monacoRef.current = monaco;
    editorRef.current = editor;
    if (libs.length > 0) applyLibs(monaco, libs);
  }, [flush, libs, applyLibs]);

  // Compute the active slot's `target_file` so we can filter the global
  // build error list down to just the diagnostics that belong on the
  // currently-visible Monaco model. Skill-prompt slots target an .md file
  // whose name contains `{{AGENT_SLUG}}` — tsc never reports against MD
  // so the substitution mismatch is moot here.
  const activeTargetFile =
    templateSlots.find((s) => s.key === active)?.target_file ?? '';
  const activeErrors = buildErrors.filter((e) => e.file === activeTargetFile);

  // Hang Monaco markers on the failing source lines (B.6-13.2). Re-runs
  // on every build_status update; resets to `[]` when the file is clean
  // so prior errors don't linger after the operator fixes them.
  useEffect(() => {
    const ed = editorRef.current as
      | { getModel(): unknown | null }
      | null;
    if (!ed) return;
    const model = ed.getModel();
    if (!model) return;
    const monacoLib = monacoRef.current as
      | {
          // Monaco exposes MarkerSeverity at the namespace root, NOT
          // under `.editor` (the latter is only the editor-creation
          // surface + setModelMarkers). The runtime error
          // "Cannot read properties of undefined (reading 'Error')"
          // came from an earlier mis-typed `monacoLib.editor.MarkerSeverity`.
          editor: {
            setModelMarkers: (
              model: unknown,
              owner: string,
              markers: ReadonlyArray<{
                severity: number;
                startLineNumber: number;
                startColumn: number;
                endLineNumber: number;
                endColumn: number;
                message: string;
                source: string;
              }>,
            ) => void;
          };
          MarkerSeverity?: { Error: number };
        }
      | null;
    if (!monacoLib) return;
    // MarkerSeverity.Error === 8 in every Monaco release of the past
    // five years; fall back to the literal so a structural mismatch in
    // the global API surface (e.g. a future @monaco-editor/react
    // bundling change) doesn't crash the markers path.
    const errorSeverity = monacoLib.MarkerSeverity?.Error ?? 8;
    const markers = activeErrors.map((e) => ({
      severity: errorSeverity,
      startLineNumber: e.line,
      startColumn: e.column,
      endLineNumber: e.line,
      endColumn: e.column + 1,
      message: `${e.code}: ${e.message}`,
      source: 'tsc',
    }));
    monacoLib.editor.setModelMarkers(model, 'tsc', markers);
  }, [activeErrors, active]);

  if (slotKeys.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-col items-center justify-center gap-2 px-8 py-12 text-center">
          <FileCode2
            className="size-5 text-[color:var(--fg-subtle)]"
            aria-hidden
          />
          <p className="font-display text-[16px] text-[color:var(--fg-muted)]">
            Noch keine Slots gefüllt.
          </p>
          <p className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
            Lass den Builder die Slots füllen oder schreib sie selbst.
          </p>
        </div>
        <div className="border-t border-[color:var(--divider)]">
          <TemplateSlotsPanel
            templateSlots={templateSlots}
            filledKeys={slotKeys}
            onPrefillBuilderChat={onPrefillBuilderChat}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TemplateSlotsPanel
        templateSlots={templateSlots}
        filledKeys={slotKeys}
        onPrefillBuilderChat={onPrefillBuilderChat}
        onSelectSlot={(k) => {
          if (slotKeys.includes(k)) onSelectSlot(k);
        }}
        activeSlot={active}
      />

      <div className="flex items-center gap-3 border-b border-[color:var(--divider)] px-5 py-3">
        <label
          htmlFor={selectId}
          className="font-mono-num text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
        >
          Slot
        </label>
        <select
          id={selectId}
          value={active}
          onChange={(e) => onSelectSlot(e.target.value)}
          className="font-mono-num rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
        >
          {slotKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <SaveBadge status={status} />
        <button
          type="button"
          onClick={() => void flush()}
          disabled={status.kind === 'pending'}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white shadow-[var(--shadow-cta)] disabled:opacity-50"
        >
          <Save className="size-3" aria-hidden />
          Speichern
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <MonacoEditor
          height="100%"
          theme="light"
          language={LANGUAGE}
          value={draft}
          onChange={onChange}
          onMount={onMonacoMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            insertSpaces: true,
            renderLineHighlight: 'gutter',
            automaticLayout: true,
            suggest: { showWords: false },
          }}
          loading={
            <div className="flex h-full items-center justify-center text-[color:var(--fg-muted)]">
              <Loader2 className="size-4 animate-spin" aria-hidden />
            </div>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TemplateSlotsPanel({
  templateSlots,
  filledKeys,
  onPrefillBuilderChat,
  onSelectSlot,
  activeSlot,
}: {
  templateSlots: ReadonlyArray<TemplateSlotDef>;
  filledKeys: ReadonlyArray<string>;
  onPrefillBuilderChat?: (
    prompt: string,
    opts?: { autoSubmit?: boolean },
  ) => void;
  onSelectSlot?: (key: string) => void;
  activeSlot?: string;
}): React.ReactElement | null {
  if (templateSlots.length === 0) return null;
  const filledSet = new Set(filledKeys);
  const missingRequired = templateSlots.filter(
    (s) => s.required && !filledSet.has(s.key),
  );
  return (
    <details
      open={missingRequired.length > 0}
      className="group border-b border-[color:var(--divider)] bg-[color:var(--bg-soft)]/30"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-5 py-2 text-[11px] text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]">
        <span className="font-mono-num text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          Vom Template gefordert
        </span>
        <span
          className={cn(
            'font-mono-num rounded-full px-1.5 text-[10px] font-semibold',
            missingRequired.length > 0
              ? 'bg-[color:var(--danger)] text-white'
              : 'bg-[color:var(--success)]/15 text-[color:var(--success)]',
          )}
        >
          {missingRequired.length === 0
            ? 'alle gefüllt'
            : `${String(missingRequired.length)} fehlt`}
        </span>
      </summary>
      <ul className="space-y-1 px-5 pb-3 pt-1">
        {templateSlots.map((slot) => {
          const filled = filledSet.has(slot.key);
          const isActive = slot.key === activeSlot;
          return (
            <li
              key={slot.key}
              className={cn(
                'flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
                filled && onSelectSlot && 'cursor-pointer hover:bg-[color:var(--bg-soft)]',
                isActive && 'bg-[color:var(--bg-soft)]',
              )}
              onClick={() => {
                if (filled && onSelectSlot) onSelectSlot(slot.key);
              }}
            >
              {filled ? (
                <CircleDot
                  className="mt-0.5 size-3 shrink-0 text-[color:var(--success)]"
                  aria-hidden
                />
              ) : (
                <CircleDashed
                  className={cn(
                    'mt-0.5 size-3 shrink-0',
                    slot.required
                      ? 'text-[color:var(--danger)]'
                      : 'text-[color:var(--fg-subtle)]',
                  )}
                  aria-hidden
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono-num text-[11px] font-semibold text-[color:var(--fg-strong)]">
                    {slot.key}
                  </span>
                  {slot.required ? (
                    <span className="font-mono-num text-[9px] uppercase tracking-[0.16em] text-[color:var(--danger)]">
                      pflicht
                    </span>
                  ) : null}
                  <span className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
                    → {slot.target_file}
                  </span>
                </div>
                {slot.description ? (
                  <p className="text-[11px] text-[color:var(--fg-muted)]">
                    {slot.description}
                  </p>
                ) : null}
              </div>
              {!filled && onPrefillBuilderChat ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPrefillBuilderChat(
                      `Fülle den Slot \`${slot.key}\` (target: ${slot.target_file})${
                        slot.description ? ` — ${slot.description}` : ''
                      } mit der TypeScript-Implementierung.`,
                      { autoSubmit: true },
                    );
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-[color:var(--accent)]/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/20"
                  title="Schickt den Prompt direkt an den Builder-Chat — der Agent legt sofort los."
                >
                  <Sparkles className="size-2.5" aria-hidden />
                  Frag den Agent
                  <ArrowRight className="size-2.5" aria-hidden />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function SaveBadge({ status }: { status: SaveStatus }): React.ReactElement | null {
  if (status.kind === 'idle') return null;
  return (
    <span
      className={cn(
        'font-mono-num inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.18em]',
        status.kind === 'error' && 'text-[color:var(--danger)]',
        status.kind === 'saved' && 'text-[color:var(--success)]',
        status.kind === 'pending' && 'text-[color:var(--accent)]',
        status.kind === 'dirty' && 'text-[color:var(--warning)]',
      )}
    >
      {status.kind === 'pending' && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {status.kind === 'saved' && <Check className="size-3" aria-hidden />}
      {status.kind === 'dirty' && <span className="size-1.5 rounded-full bg-current" />}
      {status.kind === 'error' && <AlertCircle className="size-3" aria-hidden />}
      <span className="break-words">
        {status.kind === 'pending'
          ? 'Speichern …'
          : status.kind === 'saved'
            ? 'Gespeichert'
            : status.kind === 'dirty'
              ? 'Ungespeichert'
              : status.message}
      </span>
    </span>
  );
}

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { code?: string; message?: string };
      if (body.code && body.message) return `${body.code}: ${body.message}`;
      if (body.message) return body.message;
    } catch {
      // ignore
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
