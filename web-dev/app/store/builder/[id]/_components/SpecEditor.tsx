'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2, Plus, X } from 'lucide-react';

import { ApiError, patchBuilderSpec } from '../../../../_lib/api';
import type {
  AgentSpecSkeleton,
  JsonPatch,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

import { ManifestDiffSidebar } from './ManifestDiffSidebar';
import { SetupFieldsEditor } from './SetupFieldsEditor';
import { ToolForm } from './ToolForm';
import { ToolList, type AgentStuckSnapshot } from './ToolList';
import { ToolTestModal } from './ToolTestModal';
import type { ToolSpec } from '../../../../_lib/builderTypes';

interface SpecEditorProps {
  draftId: string;
  /** Server-canonical spec. Re-renders flow through here via the
   *  SSE-driven re-fetch in Workspace; the editor never holds the spec as
   *  truth — it only buffers in-flight edits as `dirty` overrides. */
  spec: AgentSpecSkeleton;
  /** B.11-1: Most recent `agent_stuck` event from the SpecEventBus. The
   *  ToolList renders an inline marker on rows whose tool id appears in
   *  the slotKey (best-effort substring match). */
  agentStuck?: AgentStuckSnapshot | null;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/**
 * Spec-Editor (B.5-5).
 *
 * Renders a structured form over `AgentSpecSkeleton`. Every visible field
 * is a controlled input bound to either the server-canonical value
 * (`spec`) or a transient `dirty` override; on blur (and after a 500ms
 * idle window for textareas) the editor diff-encodes the change as an
 * RFC-6902 JSON-Patch and POSTs it to `PATCH /drafts/:id/spec`. The
 * server emits a `spec_patch` event on the SpecEventBus — the parent
 * Workspace re-fetches and feeds the new `spec` back in, which clears
 * the matching dirty entry.
 *
 * Tools and setup_fields stay read-only counts here; they have richer
 * editing surfaces that fit better in dedicated panes (B.5-6 territory).
 */
export function SpecEditor({ draftId, spec, agentStuck }: SpecEditorProps): React.ReactElement {
  const [dirty, setDirty] = useState<Partial<Record<string, string>>>({});
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const debounceTimers = useRef<Map<string, number>>(new Map());
  // B.11-5: Tool-Test modal — opens when the operator clicks the play icon
  // on a row. Re-keyed by tool id so re-opening a tool resets the form.
  const [testTool, setTestTool] = useState<ToolSpec | null>(null);
  // B.11-9: Manifest-Diff-Sidebar state.
  const [manifestSidebarCollapsed, setManifestSidebarCollapsed] =
    useState<boolean>(true);
  const [manifestRefreshKey, setManifestRefreshKey] = useState<number>(0);
  const lastSpecJsonRef = useRef<string>('');
  useEffect(() => {
    const next = JSON.stringify(spec);
    if (next !== lastSpecJsonRef.current) {
      lastSpecJsonRef.current = next;
      setManifestRefreshKey((k) => k + 1);
    }
  }, [spec]);

  // When the server-canonical spec catches up with our dirty edit, clear
  // the dirty entry so the input goes back to mirroring the server.
  useEffect(() => {
    setDirty((prev) => {
      let next: Partial<Record<string, string>> | null = null;
      for (const [path, value] of Object.entries(prev)) {
        const current = readByPath(spec, path);
        if (typeof current === 'string' && value === current) {
          if (next === null) next = { ...prev };
          delete next[path];
        }
      }
      return next ?? prev;
    });
  }, [spec]);

  useEffect(() => {
    return () => {
      for (const id of debounceTimers.current.values()) {
        window.clearTimeout(id);
      }
      debounceTimers.current.clear();
    };
  }, []);

  const sendPatch = useCallback(
    async (patches: JsonPatch[]) => {
      if (patches.length === 0) return;
      setStatus({ kind: 'pending' });
      try {
        await patchBuilderSpec(draftId, patches);
        setStatus({ kind: 'saved' });
        // Fade the saved indicator after a moment.
        window.setTimeout(() => {
          setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
        }, 1200);
      } catch (err) {
        setStatus({
          kind: 'error',
          message: humanizeApiError(err),
        });
      }
    },
    [draftId],
  );

  const onScalarChange = useCallback(
    (path: string, value: string): void => {
      setDirty((prev) => ({ ...prev, [path]: value }));
    },
    [],
  );

  const onScalarCommit = useCallback(
    (path: string): void => {
      const dirtyValue = dirty[path];
      if (dirtyValue === undefined) return;
      const current = readByPath(spec, path);
      if (typeof current === 'string' && current === dirtyValue) {
        setDirty((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
        return;
      }
      void sendPatch([{ op: 'replace', path, value: dirtyValue }]);
    },
    [dirty, sendPatch, spec],
  );

  const onScalarDebouncedCommit = useCallback(
    (path: string): void => {
      const existing = debounceTimers.current.get(path);
      if (existing) window.clearTimeout(existing);
      const id = window.setTimeout(() => {
        debounceTimers.current.delete(path);
        onScalarCommit(path);
      }, 500);
      debounceTimers.current.set(path, id);
    },
    [onScalarCommit],
  );

  const onArrayAdd = useCallback(
    (path: string, value: string): void => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const current = readByPath(spec, path);
      const next = Array.isArray(current) ? [...current, trimmed] : [trimmed];
      void sendPatch([{ op: 'replace', path, value: next }]);
    },
    [sendPatch, spec],
  );

  const onArrayRemove = useCallback(
    (path: string, index: number): void => {
      const current = readByPath(spec, path);
      if (!Array.isArray(current)) return;
      const next = current.filter((_, i) => i !== index);
      void sendPatch([{ op: 'replace', path, value: next }]);
    },
    [sendPatch, spec],
  );

  const valueOf = useCallback(
    (path: string): string => {
      const dv = dirty[path];
      if (dv !== undefined) return dv;
      const v = readByPath(spec, path);
      return typeof v === 'string' ? v : '';
    },
    [dirty, spec],
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <FieldGroup title="Identität">
          <ScalarField
            label="Agent-ID"
            placeholder="de.byte5.agent.example"
            value={valueOf('/id')}
            onChange={(v) => onScalarChange('/id', v)}
            onBlur={() => onScalarCommit('/id')}
            mono
          />
          <ScalarField
            label="Name"
            placeholder="z.B. SEO-Analyst"
            value={valueOf('/name')}
            onChange={(v) => onScalarChange('/name', v)}
            onBlur={() => onScalarCommit('/name')}
          />
          <ScalarField
            label="Version"
            placeholder="0.1.0"
            value={valueOf('/version')}
            onChange={(v) => onScalarChange('/version', v)}
            onBlur={() => onScalarCommit('/version')}
            mono
          />
          <ScalarField
            label="Kategorie"
            placeholder="other"
            value={valueOf('/category')}
            onChange={(v) => onScalarChange('/category', v)}
            onBlur={() => onScalarCommit('/category')}
          />
        </FieldGroup>

        <FieldGroup title="Beschreibung">
          <TextareaField
            label="Description"
            value={valueOf('/description')}
            onChange={(v) => {
              onScalarChange('/description', v);
              onScalarDebouncedCommit('/description');
            }}
            rows={2}
          />
        </FieldGroup>

        <FieldGroup title="Skill">
          <ScalarField
            label="Rolle"
            placeholder="z.B. Vertriebs-Analyst"
            value={valueOf('/skill/role')}
            onChange={(v) => onScalarChange('/skill/role', v)}
            onBlur={() => onScalarCommit('/skill/role')}
          />
          <ScalarField
            label="Tonalität (optional)"
            placeholder="z.B. präzise, sachlich"
            value={valueOf('/skill/tonality')}
            onChange={(v) => onScalarChange('/skill/tonality', v)}
            onBlur={() => onScalarCommit('/skill/tonality')}
          />
        </FieldGroup>

        <FieldGroup title="Playbook">
          <TextareaField
            label="when_to_use"
            value={valueOf('/playbook/when_to_use')}
            onChange={(v) => {
              onScalarChange('/playbook/when_to_use', v);
              onScalarDebouncedCommit('/playbook/when_to_use');
            }}
            rows={3}
          />
          <ArrayField
            label="not_for"
            placeholder="Anti-Pattern eingeben"
            items={spec.playbook?.not_for ?? []}
            onAdd={(v) => onArrayAdd('/playbook/not_for', v)}
            onRemove={(i) => onArrayRemove('/playbook/not_for', i)}
          />
          <ArrayField
            label="example_prompts"
            placeholder="Beispiel-Prompt"
            items={spec.playbook?.example_prompts ?? []}
            onAdd={(v) => onArrayAdd('/playbook/example_prompts', v)}
            onRemove={(i) => onArrayRemove('/playbook/example_prompts', i)}
          />
        </FieldGroup>

        <FieldGroup title="Abhängigkeiten & Netzwerk">
          <ArrayField
            label="depends_on"
            placeholder="z.B. @omadia/knowledge-graph-neon"
            items={spec.depends_on ?? []}
            onAdd={(v) => onArrayAdd('/depends_on', v)}
            onRemove={(i) => onArrayRemove('/depends_on', i)}
            mono
          />
          <ArrayField
            label="network.outbound"
            placeholder="z.B. api.example.com"
            items={spec.network?.outbound ?? []}
            onAdd={(v) => onArrayAdd('/network/outbound', v)}
            onRemove={(i) => onArrayRemove('/network/outbound', i)}
            mono
          />
        </FieldGroup>

        <FieldGroup title="Setup-Felder (Credentials & Config)">
          <SetupFieldsEditor draftId={draftId} fields={spec.setup_fields ?? []} />
        </FieldGroup>

        <FieldGroup title="Tools">
          <ToolList
            tools={spec.tools ?? []}
            agentStuck={agentStuck}
            onPatch={sendPatch}
            onRequestTest={(t) => setTestTool(t)}
            renderExpandedBody={(tool, index) => (
              <ToolForm
                tool={tool}
                index={index}
                otherToolIds={(spec.tools ?? [])
                  .filter((_, i) => i !== index)
                  .map((t) => t.id)}
                onPatch={sendPatch}
              />
            )}
          />
        </FieldGroup>
      </div>

      <SaveBadge status={status} />

      {testTool ? (
        <ToolTestModal
          draftId={draftId}
          tool={testTool}
          onClose={() => setTestTool(null)}
          onSaveTestCase={async (entry) => {
            // B.11-6: append to spec.test_cases[] (auto-creates the array
            // when absent — JSON-Patch `add /test_cases/-` against an
            // undefined parent fails, so the path differs).
            const hasArray = Array.isArray(spec.test_cases);
            await sendPatch(
              hasArray
                ? [{ op: 'add', path: '/test_cases/-', value: entry }]
                : [{ op: 'add', path: '/test_cases', value: [entry] }],
            );
          }}
        />
      ) : null}
      </div>
      <ManifestDiffSidebar
        draftId={draftId}
        refreshKey={manifestRefreshKey}
        collapsed={manifestSidebarCollapsed}
        onToggle={(next) => setManifestSidebarCollapsed(next)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

interface ScalarFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  mono?: boolean;
}

function ScalarField({
  label,
  value,
  placeholder,
  onChange,
  onBlur,
  mono = false,
}: ScalarFieldProps): React.ReactElement {
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={cn(
          'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-[13px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)]',
          'focus:border-[color:var(--accent)] focus:outline-none',
          mono && 'font-mono-num',
        )}
      />
    </div>
  );
}

interface TextareaFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
}

function TextareaField({
  label,
  value,
  onChange,
  rows = 3,
}: TextareaFieldProps): React.ReactElement {
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
      >
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-[13px] leading-snug text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
      />
    </div>
  );
}

interface ArrayFieldProps {
  label: string;
  /** Defensive: real data has been observed with non-string entries
   *  (e.g. the BuilderAgent's `applyJsonPatchesRaw` no-validate path
   *  has written `{host, purpose}` objects into `network.outbound`).
   *  We accept `unknown[]` and coerce per-item via `coerceArrayLabel`
   *  so a stale draft doesn't crash the React tree. */
  items: ReadonlyArray<unknown>;
  placeholder?: string;
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  mono?: boolean;
}

function ArrayField({
  label,
  items,
  placeholder,
  onAdd,
  onRemove,
  mono = false,
}: ArrayFieldProps): React.ReactElement {
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const submit = useCallback(() => {
    if (draft.trim().length === 0) return;
    onAdd(draft);
    setDraft('');
  }, [draft, onAdd]);
  return (
    <div>
      <label
        htmlFor={inputId}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]"
      >
        {label}
      </label>
      {items.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {items.map((item, i) => {
            const labelText = coerceArrayLabel(item);
            const malformed = typeof item !== 'string';
            return (
              <li
                key={`${labelText}-${String(i)}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md bg-[color:var(--bg-soft)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)]',
                  mono && 'font-mono-num',
                  malformed &&
                    'border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 text-[color:var(--warning)]',
                )}
                title={malformed ? 'Eintrag ist kein String — wird angezeigt als Best-Effort' : undefined}
              >
                <span className="break-all">{labelText}</span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`${label} entfernen`}
                  className="rounded p-0.5 text-[color:var(--fg-subtle)] hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)]"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex gap-1.5">
        <input
          id={inputId}
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className={cn(
            'flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-1.5 text-[12px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)]',
            'focus:border-[color:var(--accent)] focus:outline-none',
            mono && 'font-mono-num',
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={draft.trim().length === 0}
          className="inline-flex items-center gap-1 rounded-md bg-[color:var(--accent)] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-[var(--shadow-cta)] disabled:opacity-40"
        >
          <Plus className="size-3" aria-hidden />
          Add
        </button>
      </div>
    </div>
  );
}

function SaveBadge({ status }: { status: SaveStatus }): React.ReactElement {
  const content = useMemo(() => {
    if (status.kind === 'pending') {
      return (
        <>
          <Loader2 className="size-3 animate-spin" aria-hidden />
          <span>Speichern …</span>
        </>
      );
    }
    if (status.kind === 'saved') {
      return (
        <>
          <Check className="size-3" aria-hidden />
          <span>Gespeichert</span>
        </>
      );
    }
    if (status.kind === 'error') {
      return (
        <>
          <AlertCircle className="size-3 text-[color:var(--danger)]" aria-hidden />
          <span className="break-words text-[color:var(--danger)]">
            {status.message}
          </span>
        </>
      );
    }
    return null;
  }, [status]);
  if (status.kind === 'idle') return <></>;
  return (
    <div className="border-t border-[color:var(--divider)] px-5 py-2">
      <div className="font-mono-num inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-muted)]">
        {content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Read a value from a JSON-shaped object using an RFC-6901 JSON-Pointer.
 * Returns `undefined` for any missing intermediate segment.
 */
function readByPath(target: unknown, path: string): unknown {
  if (path === '') return target;
  const segments = path.split('/').slice(1).map(decodePointerSegment);
  let cur: unknown = target;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function decodePointerSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Pick a human-readable label for an array entry that *should* have been a
 * string but might be an object — the BuilderAgent's no-validate
 * patch path lets it write loose JSON into spec arrays today. Strings
 * pass through; objects with an obvious primary field
 * (host/url/name/id) print that field; anything else gets `JSON.stringify`.
 */
function coerceArrayLabel(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item === null || item === undefined) return '';
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    for (const key of ['host', 'url', 'name', 'id'] as const) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    try {
      return JSON.stringify(item);
    } catch {
      return '[object]';
    }
  }
  return String(item);
}

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as {
        code?: string;
        message?: string;
      };
      if (body.code && body.message) return `${body.code}: ${body.message}`;
      if (body.message) return body.message;
    } catch {
      // ignore
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
