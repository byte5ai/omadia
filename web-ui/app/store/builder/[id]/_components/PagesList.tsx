'use client';

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { JsonPatch, ToolSpec, UiRoute } from '../../../../_lib/builderTypes';

import { PageForm } from './PageForm';

interface PagesListProps {
  uiRoutes: ReadonlyArray<UiRoute>;
  /** All defined tools in spec — feeds the data_binding.tool_id dropdown. */
  tools: ReadonlyArray<ToolSpec>;
  /** Draft id — threaded down to PageForm → PagePreviewFrame for the
   *  live-preview iframe endpoint. */
  draftId: string;
  /** Slots map from the draft — seeds InlineSlotEditor with the current
   *  ui-<id>-component / ui-<id>-render content. NOT a live mirror. */
  slots: Record<string, string | undefined>;
  onPatch: (patches: JsonPatch[]) => Promise<void> | void;
}

/**
 * B.12-5 — Workspace Pages-Tab. Lists `spec.ui_routes[]` as collapsible
 * rows; clicking a row expands the `PageForm` for inline edit. The
 * `Add Page` button appends a placeholder route + auto-expands it so the
 * operator lands in the form ready to type. Patches flow through the
 * shared `onPatch` (JSON-Patch via PATCH /spec) — same mechanism as
 * ToolList.
 */
export function PagesList({
  uiRoutes,
  tools,
  draftId,
  slots,
  onPatch,
}: PagesListProps): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(() => uiRoutes.map((r) => r.id), [uiRoutes]);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      const moved = uiRoutes[oldIndex];
      if (!moved) return;
      // RFC-6902 reorder: atomic remove + add at new index. Mirrors the
      // ToolList pattern so the backend SpecPatcher sees a coherent
      // array-move (some servers don't honour the `move` op).
      void onPatch([
        { op: 'remove', path: `/ui_routes/${oldIndex}` },
        { op: 'add', path: `/ui_routes/${newIndex}`, value: moved },
      ]);
    },
    [ids, uiRoutes, onPatch],
  );

  const onAdd = useCallback(() => {
    const nextId = nextRouteId(uiRoutes);
    const next: UiRoute = {
      id: nextId,
      path: `/${nextId}`,
      tab_label: humanizeId(nextId),
      page_title: humanizeId(nextId),
      refresh_seconds: 60,
      render_mode: 'library',
      ui_template: 'list-card',
      interactive: false,
      item_template: { title: '${item.title}' },
    };
    void onPatch([{ op: 'add', path: '/ui_routes/-', value: next }]);
    setExpandedId(nextId);
  }, [uiRoutes, onPatch]);

  const onRemove = useCallback(
    (index: number) => {
      void onPatch([{ op: 'remove', path: `/ui_routes/${index}` }]);
      setExpandedId(null);
    },
    [onPatch],
  );

  const onPatchRoute = useCallback(
    (index: number, patches: JsonPatch[]) => {
      // Rebase each patch so its path slots into the ui_routes[index] subtree.
      const rebased = patches.map((p) => ({
        ...p,
        path: `/ui_routes/${index}${p.path}`,
      }));
      return onPatch(rebased);
    },
    [onPatch],
  );

  if (uiRoutes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--border)] bg-[color:var(--bg)] p-4">
        <p className="text-[12px] text-[color:var(--fg-strong)]">
          Noch keine Dashboard-Pages definiert.
        </p>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          Eine Page wird zu einem <code>/p/&lt;plugin&gt;/&lt;pfad&gt;</code>-Endpoint
          und einer Hub-Karte für Teams.
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-3 inline-flex items-center gap-1 rounded-md bg-[color:var(--accent)] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-[var(--shadow-cta)]"
        >
          <Plus className="size-3" aria-hidden />
          Erste Page hinzufügen
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1.5">
            {uiRoutes.map((route, index) => {
              const isExpanded = expandedId === route.id;
              return (
                <SortableRow
                  key={route.id}
                  route={route}
                  index={index}
                  isExpanded={isExpanded}
                  tools={tools}
                  draftId={draftId}
                  slots={slots}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === route.id ? null : route.id))
                  }
                  onRemove={() => {
                    if (confirm(`Page "${route.tab_label || route.id}" löschen?`)) {
                      onRemove(index);
                    }
                  }}
                  onPatchRoute={(patches) => onPatchRoute(index, patches)}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]"
      >
        <Plus className="size-3" aria-hidden />
        Page hinzufügen
      </button>
    </div>
  );
}

interface SortableRowProps {
  route: UiRoute;
  index: number;
  isExpanded: boolean;
  tools: ReadonlyArray<ToolSpec>;
  draftId: string;
  slots: Record<string, string | undefined>;
  onToggle: () => void;
  onRemove: () => void;
  onPatchRoute: (patches: JsonPatch[]) => Promise<void> | void;
}

function SortableRow({
  route,
  index,
  isExpanded,
  tools,
  draftId,
  slots,
  onToggle,
  onRemove,
  onPatchRoute,
}: SortableRowProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: route.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  void index;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg)]"
    >
      <div className="flex w-full items-center gap-2 px-3 py-2 text-[12px]">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Reorder"
          className="cursor-grab text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)] active:cursor-grabbing"
        >
          <GripVertical className="size-3" />
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left hover:bg-[color:var(--bg-hover)]"
        >
          {isExpanded ? (
            <ChevronDown className="size-3 text-[color:var(--fg-muted)]" />
          ) : (
            <ChevronRight className="size-3 text-[color:var(--fg-muted)]" />
          )}
          <span className="font-medium text-[color:var(--fg-strong)]">
            {route.tab_label || route.id}
          </span>
          <span className="text-[color:var(--fg-muted)]">{route.path}</span>
        </button>
        <ModeBadge mode={route.render_mode} />
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-[color:var(--fg-muted)] hover:bg-rose-50 hover:text-rose-700"
          aria-label="Page löschen"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      {isExpanded ? (
        <div className="border-t border-[color:var(--border)] bg-[color:var(--bg-subtle)] px-3 py-3">
          <PageForm
            route={route}
            tools={tools}
            draftId={draftId}
            slots={slots}
            onPatch={onPatchRoute}
          />
        </div>
      ) : null}
    </li>
  );
}

function ModeBadge({ mode }: { mode: UiRoute['render_mode'] }): React.ReactElement {
  const color =
    mode === 'library'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : mode === 'react-ssr'
        ? 'bg-sky-50 text-sky-700 border-sky-200'
        : 'bg-amber-50 text-amber-700 border-amber-200';
  const label =
    mode === 'library' ? 'Library' : mode === 'react-ssr' ? 'React SSR' : 'Free-form HTML';
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${color}`}
    >
      {label}
    </span>
  );
}

function nextRouteId(existing: ReadonlyArray<UiRoute>): string {
  const taken = new Set(existing.map((r) => r.id));
  for (let i = 1; i < 100; i += 1) {
    const candidate = i === 1 ? 'dashboard' : `page-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `page-${Date.now()}`;
}

function humanizeId(id: string): string {
  return id
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}
