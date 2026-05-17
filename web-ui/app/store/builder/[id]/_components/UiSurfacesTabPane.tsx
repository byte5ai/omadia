'use client';

import { useCallback, useState } from 'react';

import { ApiError, patchBuilderSpec } from '../../../../_lib/api';
import type {
  AgentSpecSkeleton,
  JsonPatch,
} from '../../../../_lib/builderTypes';

import { UiSurfacesEditor } from './UiSurfacesEditor';

interface UiSurfacesTabPaneProps {
  draftId: string;
  spec: AgentSpecSkeleton;
  /**
   * fillSlot-written values from `draft.slots` (separate DB column from
   * `draft.spec.slots`). Without this the InlineSlotEditor for react-ssr /
   * free-form-html dashboard pages would show the default stub instead of
   * the operator-filled (or agent-filled) source, because the editor's
   * `slots[slotKey]` fallback to `defaultReactSsrStub` only triggers when
   * the value is missing — and `spec.slots[slotKey]` is empty for any
   * slot written via fill_slot (which lands on draft.slots).
   */
  draftSlots: Readonly<Record<string, string>>;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/**
 * Full-pane host for `UiSurfacesEditor`. Lives as its own EditorTab
 * (`ui-surfaces`) next to spec/slots/persona — gives the Admin UI +
 * Dashboard Pages content the full editor-pane width instead of
 * being clipped inside the Spec-tab's narrow column.
 *
 * Owns its own debounce-free PATCH-spec flow: every patch from the
 * embedded editor (toggle Admin UI, edit path, add Dashboard Page,
 * etc.) goes straight to the server. No dirty-buffer, no debounce —
 * the inputs that trigger patches here are clicks/toggles/dropdowns,
 * not key-by-key text edits. Saved-badge is the surface for feedback.
 */
export function UiSurfacesTabPane({
  draftId,
  spec,
  draftSlots,
}: UiSurfacesTabPaneProps): React.ReactElement {
  // Merge spec.slots with draft.slots so the InlineSlotEditor sees
  // fillSlot-written values. draft.slots wins on conflict — fillSlot
  // is the canonical write path, patch_spec to /slots/<key> is the
  // legacy fallback. Same merge order as the server-side codegen
  // (codegen.ts: `allSlots = { ...spec.slots, ...opts.slots }`).
  const mergedSlots: Record<string, string | undefined> = {
    ...(spec.slots ?? {}),
    ...draftSlots,
  };
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });

  const sendPatch = useCallback(
    async (patches: JsonPatch[]) => {
      if (patches.length === 0) return;
      setStatus({ kind: 'pending' });
      try {
        await patchBuilderSpec(draftId, patches);
        setStatus({ kind: 'saved' });
        window.setTimeout(() => {
          setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
        }, 1200);
      } catch (err) {
        setStatus({ kind: 'error', message: humanizeApiError(err) });
      }
    },
    [draftId],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <header className="space-y-1">
          <h2 className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
            UI-Surfaces
          </h2>
          <p className="text-[11px] text-[color:var(--fg-muted)]">
            Plugin-UI nach außen exposen: ein Admin-iframe für Operator-pflegte
            Daten (single), und 0–N Dashboard-Pages für end-user-facing
            Browser-/Teams-Tab-Anzeigen.
          </p>
        </header>

        <UiSurfacesEditor
          adminUiPath={spec.admin_ui_path}
          uiRoutes={spec.ui_routes ?? []}
          tools={spec.tools ?? []}
          draftId={draftId}
          slots={mergedSlots}
          onPatch={sendPatch}
        />
      </div>
      <SaveBadge status={status} />
    </div>
  );
}

function SaveBadge({ status }: { status: SaveStatus }): React.ReactElement | null {
  if (status.kind === 'idle') return null;
  const cls =
    status.kind === 'error'
      ? 'bg-rose-50 text-rose-900 border-rose-200'
      : status.kind === 'saved'
        ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
        : 'bg-slate-50 text-slate-700 border-slate-200';
  const label =
    status.kind === 'pending'
      ? 'Speichert…'
      : status.kind === 'saved'
        ? 'Gespeichert'
        : `Fehler: ${status.message}`;
  return (
    <div
      className={`mx-5 mb-3 rounded-md border px-3 py-1.5 text-[11px] ${cls}`}
    >
      {label}
    </div>
  );
}

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    return `${String(err.status)} — ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
