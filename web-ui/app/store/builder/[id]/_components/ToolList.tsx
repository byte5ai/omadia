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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Layers,
  Play,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { JsonPatch, ToolSpec } from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

import { ToolBulkImportModal } from './ToolBulkImportModal';
import { ToolTemplatesModal } from './ToolTemplatesModal';

export interface AgentStuckSnapshot {
  slotKey: string;
  attempts: number;
  lastReason: string;
  lastSummary: string;
  lastErrorCount: number;
}

interface ToolListProps {
  tools: ReadonlyArray<ToolSpec>;
  agentStuck?: AgentStuckSnapshot | null;
  onPatch: (patches: JsonPatch[]) => Promise<void> | void;
  /**
   * B.11-2 will mount a `<ToolForm>` here for the expanded row body.
   * In B.11-1 the slot stays empty so the placeholder area is visible
   * but inert.
   */
  renderExpandedBody?: (tool: ToolSpec, index: number) => React.ReactNode;
  /** B.11-5: opens the ToolTestModal for the given tool. When omitted
   *  (e.g. preview not yet booted) the test button is hidden. */
  onRequestTest?: (tool: ToolSpec) => void;
}

/**
 * B.11-1: Workspace tool authoring — list view.
 *
 * Replaces the SpecEditor placeholder with a sortable, expandable list of
 * `ToolSpec` rows. Reorder is wired via dnd-kit and emits an atomic
 * `remove + add` JSON-Patch pair (RFC-6902 doesn't define a `move` op
 * that all servers honour). The AgentStuck marker hangs an orange dot
 * on rows whose tool id appears in the most recent `agent_stuck` event's
 * slotKey — best-effort substring match because slot keys carry a
 * file-shape suffix (e.g. `tool-foo-handler`) that the event payload
 * does not split out today.
 */
export function ToolList({
  tools,
  agentStuck,
  onPatch,
  renderExpandedBody,
  onRequestTest,
}: ToolListProps): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);
  const [importOpen, setImportOpen] = useState<boolean>(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(() => tools.map((t) => t.id), [tools]);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      const moved = tools[oldIndex];
      if (!moved) return;
      // Atomic remove + add at new index — RFC-6902 reorder shape.
      void onPatch([
        { op: 'remove', path: `/tools/${oldIndex}` },
        { op: 'add', path: `/tools/${newIndex}`, value: moved },
      ]);
    },
    [ids, tools, onPatch],
  );

  const onAdd = useCallback(() => {
    const next = nextToolId(tools);
    void onPatch([
      {
        op: 'add',
        path: '/tools/-',
        value: { id: next, description: '' },
      },
    ]);
    setExpandedId(next);
  }, [tools, onPatch]);

  const onInsertTemplate = useCallback(
    (tool: ToolSpec) => {
      void onPatch([{ op: 'add', path: '/tools/-', value: tool }]);
      setExpandedId(tool.id);
    },
    [onPatch],
  );

  const onRemove = useCallback(
    (index: number) => {
      void onPatch([{ op: 'remove', path: `/tools/${index}` }]);
      setExpandedId(null);
    },
    [onPatch],
  );

  if (tools.length === 0) {
    return (
      <>
        <div className="rounded-md border border-dashed border-[color:var(--border)] bg-[color:var(--bg)] px-4 py-6 text-center">
          <p className="text-[12px] text-[color:var(--fg-muted)]">
            Noch keine Tools definiert.
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex items-center gap-1 rounded-md bg-[color:var(--accent)] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-[var(--shadow-cta)]"
            >
              <Plus className="size-3" aria-hidden />
              Erstes Tool hinzufügen
            </button>
            <button
              type="button"
              onClick={() => setTemplatesOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]"
            >
              <Layers className="size-3" aria-hidden />
              Aus Template
            </button>
          </div>
        </div>
        {templatesOpen ? (
          <ToolTemplatesModal
            existingToolIds={ids}
            onClose={() => setTemplatesOpen(false)}
            onInsert={onInsertTemplate}
          />
        ) : null}
      </>
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
            {tools.map((tool, index) => {
              const isExpanded = expandedId === tool.id;
              const stuck = isStuckForTool(agentStuck, tool.id);
              return (
                <SortableRow
                  key={tool.id}
                  tool={tool}
                  index={index}
                  isExpanded={isExpanded}
                  stuck={stuck}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === tool.id ? null : tool.id))
                  }
                  onRemove={() => onRemove(index)}
                  onTest={onRequestTest ? () => onRequestTest(tool) : undefined}
                  renderExpandedBody={renderExpandedBody}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]"
        >
          <Plus className="size-3" aria-hidden />
          Tool hinzufügen
        </button>
        <button
          type="button"
          onClick={() => setTemplatesOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]"
        >
          <Layers className="size-3" aria-hidden />
          Aus Template
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]"
        >
          <Upload className="size-3" aria-hidden />
          Import
        </button>
      </div>
      {templatesOpen ? (
        <ToolTemplatesModal
          existingToolIds={ids}
          onClose={() => setTemplatesOpen(false)}
          onInsert={onInsertTemplate}
        />
      ) : null}
      {importOpen ? (
        <ToolBulkImportModal
          existingToolIds={ids}
          onClose={() => setImportOpen(false)}
          onImport={(patches) => onPatch(patches)}
        />
      ) : null}
    </div>
  );
}

interface SortableRowProps {
  tool: ToolSpec;
  index: number;
  isExpanded: boolean;
  stuck: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onTest?: () => void;
  renderExpandedBody?: (tool: ToolSpec, index: number) => React.ReactNode;
}

function SortableRow({
  tool,
  index,
  isExpanded,
  stuck,
  onToggle,
  onRemove,
  onTest,
  renderExpandedBody,
}: SortableRowProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tool.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-md border border-[color:var(--border)] bg-[color:var(--bg)]',
        isDragging && 'opacity-60 shadow-[var(--shadow-cta)]',
      )}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          aria-label="Tool reorder handle"
          className="cursor-grab touch-none rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)] active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          className="flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[color:var(--bg-soft)]"
        >
          {isExpanded ? (
            <ChevronDown className="size-3 text-[color:var(--fg-subtle)]" aria-hidden />
          ) : (
            <ChevronRight className="size-3 text-[color:var(--fg-subtle)]" aria-hidden />
          )}
          <span className="font-mono-num text-[12px] text-[color:var(--fg-strong)]">
            {tool.id || <span className="italic text-[color:var(--fg-subtle)]">unnamed</span>}
          </span>
          {tool.description ? (
            <span className="truncate text-[11px] text-[color:var(--fg-muted)]">
              {tool.description}
            </span>
          ) : (
            <span className="truncate text-[11px] italic text-[color:var(--fg-subtle)]">
              keine Beschreibung
            </span>
          )}
          {stuck ? (
            <AgentStuckMarker />
          ) : null}
        </button>
        {onTest ? (
          <button
            type="button"
            onClick={onTest}
            aria-label={`Tool ${tool.id} testen`}
            title="Direkt gegen Preview ausführen"
            className="rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--accent)]"
          >
            <Play className="size-3" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Tool ${tool.id} entfernen`}
          className="rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)]"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>
      {isExpanded ? (
        <div className="border-t border-[color:var(--border)] bg-[color:var(--bg-soft)] px-3 py-2">
          {renderExpandedBody ? (
            renderExpandedBody(tool, index)
          ) : (
            <p className="text-[11px] italic text-[color:var(--fg-muted)]">
              Tool-Form folgt in B.11-2.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function AgentStuckMarker(): React.ReactElement {
  return (
    <span
      title="Builder-Agent ist auf diesem Tool/Slot stecken geblieben — manuell prüfen"
      className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--warning)]"
    >
      <AlertTriangle className="size-2.5" aria-hidden />
      stuck
    </span>
  );
}

function isStuckForTool(
  snap: AgentStuckSnapshot | null | undefined,
  toolId: string,
): boolean {
  if (!snap || !toolId) return false;
  const key = snap.slotKey.toLowerCase();
  return key.includes(toolId.toLowerCase());
}

function nextToolId(tools: ReadonlyArray<ToolSpec>): string {
  const taken = new Set(tools.map((t) => t.id));
  let n = tools.length + 1;
  let candidate = `new_tool_${String(n)}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `new_tool_${String(n)}`;
  }
  return candidate;
}
