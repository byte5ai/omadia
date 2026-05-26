'use client';

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import type {
  OperatorAgentDto,
  PluginCatalogEntryDto,
  PluginSetupFieldDto,
} from '../../../_lib/agents';

const AVAILABLE_ID = '__available';
const ENABLED_ID = '__enabled';

interface SelectedEntry {
  enabled: boolean;
  config: Record<string, unknown>;
}

interface PluginsDndProps {
  readonly agent: OperatorAgentDto;
  readonly catalog: PluginCatalogEntryDto[];
  readonly disabled: boolean;
  readonly onReplace: (
    plugins: Array<{
      id: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }>,
  ) => void;
}

/**
 * Two-column drag-drop plugin selector with dependency grouping.
 *
 *  - Left column: Available plugins (installed but not attached to this Agent).
 *  - Right column: Enabled plugins (attached to this Agent).
 *  - Plugins are draggable between columns; dropping into "Enabled" attaches,
 *    dropping into "Available" detaches.
 *  - Within each column plugins are grouped by dependency: children
 *    (`depends_on` lists a parent that is in the same column) are rendered
 *    immediately below their parent with a left indent. A child whose parent
 *    is in the OTHER column gets a "needs parent" warning chip.
 *  - Orphan rows (in `agent.plugins` but no longer in the catalog) appear in
 *    a small "Stale" section under "Enabled" so the operator can detach them.
 *
 * Local state is intentional: edits accumulate until the operator hits
 * "Save", at which point we ship a single `replaceAgentPlugins` PUT. The
 * parent uses `key={...}` to remount this component after the server
 * round-trip so the local state reseeds from fresh props.
 */
export function PluginsDnd(props: PluginsDndProps): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const initialMap = useMemo(() => {
    const m = new Map<string, SelectedEntry>();
    for (const p of props.agent.plugins) {
      m.set(p.id, { enabled: p.enabled, config: p.config });
    }
    return m;
  }, [props.agent.plugins]);

  const [selected, setSelected] = useState<Map<string, SelectedEntry>>(
    initialMap,
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const catalogById = useMemo(() => {
    const m = new Map<string, PluginCatalogEntryDto>();
    for (const entry of props.catalog) m.set(entry.id, entry);
    return m;
  }, [props.catalog]);

  // Partition catalog entries into "available" vs "enabled" using the
  // local selection map. Orphans (selected but not in catalog) are surfaced
  // separately so they cannot be lost on save.
  const enabledIds = useMemo(
    () => props.catalog.filter((c) => selected.has(c.id)).map((c) => c.id),
    [props.catalog, selected],
  );
  const availableIds = useMemo(
    () => props.catalog.filter((c) => !selected.has(c.id)).map((c) => c.id),
    [props.catalog, selected],
  );
  const orphans = useMemo(
    () =>
      Array.from(selected.keys()).filter((id) => !catalogById.has(id)),
    [selected, catalogById],
  );

  // Order within each column so that dependants render right after their
  // parent (indented). The relation is approximate: we only indent under
  // the FIRST parent that is in the SAME column — cross-column parents
  // get a warning chip instead.
  const enabledOrdered = useMemo(
    () => groupByDependency(enabledIds, catalogById, new Set(enabledIds)),
    [enabledIds, catalogById],
  );
  const availableOrdered = useMemo(
    () =>
      groupByDependency(availableIds, catalogById, new Set(availableIds)),
    [availableIds, catalogById],
  );

  function findContainer(id: string): typeof AVAILABLE_ID | typeof ENABLED_ID | null {
    if (id === AVAILABLE_ID) return AVAILABLE_ID;
    if (id === ENABLED_ID) return ENABLED_ID;
    if (selected.has(id)) return ENABLED_ID;
    if (catalogById.has(id)) return AVAILABLE_ID;
    return null;
  }

  function onDragStart(e: DragStartEvent): void {
    setActiveId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;

    const fromContainer = findContainer(activeId);
    const toContainer = findContainer(overId);
    if (!fromContainer || !toContainer) return;
    if (fromContainer === toContainer) return; // intra-column reorder is cosmetic only

    setSelected((prev) => {
      const next = new Map(prev);
      if (toContainer === ENABLED_ID && !next.has(activeId)) {
        next.set(activeId, { enabled: true, config: {} });
      } else if (toContainer === AVAILABLE_ID && next.has(activeId)) {
        next.delete(activeId);
      }
      return next;
    });
  }

  function toggleEnabled(id: string): void {
    setSelected((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      if (!cur) return prev;
      next.set(id, { ...cur, enabled: !cur.enabled });
      return next;
    });
  }

  function detach(id: string): void {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function attach(id: string): void {
    setSelected((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, { enabled: true, config: {} });
      return next;
    });
  }

  function setConfigKey(
    pluginId: string,
    fieldKey: string,
    value: string | boolean | number | string[],
  ): void {
    setSelected((prev) => {
      const next = new Map(prev);
      const cur = next.get(pluginId);
      if (!cur) return prev;
      next.set(pluginId, {
        ...cur,
        config: { ...cur.config, [fieldKey]: value },
      });
      return next;
    });
  }

  function submit(): void {
    const out: Array<{
      id: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }> = [];
    for (const [id, entry] of selected) {
      out.push({ id, enabled: entry.enabled, config: entry.config });
    }
    props.onReplace(out);
  }

  const activeEntry = activeId ? catalogById.get(activeId) : undefined;

  return (
    <div>
      <h4 className="mb-2 flex items-center justify-between text-sm font-medium">
        {t('pluginsHeading')}
        <button
          type="button"
          className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
          disabled={props.disabled}
          onClick={submit}
        >
          {t('save')}
        </button>
      </h4>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Column
            id={AVAILABLE_ID}
            title={t('pluginsAvailable')}
            count={availableOrdered.length}
            emptyLabel={t('pluginsAvailableEmpty')}
          >
            {availableOrdered.map((row) => {
              const entry = catalogById.get(row.id);
              if (!entry) return null;
              return (
                <DraggablePluginTile
                  key={row.id}
                  entry={entry}
                  depth={row.depth}
                  parentSatisfied={row.parentSatisfied}
                  selection={null}
                  disabled={props.disabled}
                  onAttach={() => attach(row.id)}
                  expanded={false}
                  onToggleExpanded={() => undefined}
                  onToggleEnabled={() => undefined}
                  onSetConfigKey={() => undefined}
                />
              );
            })}
          </Column>

          <Column
            id={ENABLED_ID}
            title={t('pluginsEnabled')}
            count={enabledOrdered.length + orphans.length}
            emptyLabel={t('pluginsEnabledEmpty')}
          >
            {enabledOrdered.map((row) => {
              const entry = catalogById.get(row.id);
              const selection = selected.get(row.id);
              if (!entry || !selection) return null;
              return (
                <DraggablePluginTile
                  key={row.id}
                  entry={entry}
                  depth={row.depth}
                  parentSatisfied={row.parentSatisfied}
                  selection={selection}
                  disabled={props.disabled}
                  onAttach={() => undefined}
                  expanded={expanded === row.id}
                  onToggleExpanded={() =>
                    setExpanded((prev) => (prev === row.id ? null : row.id))
                  }
                  onToggleEnabled={() => toggleEnabled(row.id)}
                  onDetach={() => detach(row.id)}
                  onSetConfigKey={(fk, v) => setConfigKey(row.id, fk, v)}
                />
              );
            })}
            {orphans.length > 0 && (
              <div className="mt-3 border-t border-amber-200 pt-2">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-amber-700">
                  {t('orphanPluginsHeading')}
                </p>
                {orphans.map((id) => (
                  <div
                    key={id}
                    className="mb-1 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs"
                  >
                    <span className="font-mono text-amber-900">{id}</span>
                    <span className="text-[10px] uppercase text-amber-800">
                      {t('orphanPluginBadge')}
                    </span>
                    <button
                      type="button"
                      className="ml-auto rounded border border-amber-300 bg-white px-1.5 py-0 text-[10px] hover:bg-amber-100"
                      disabled={props.disabled}
                      onClick={() => detach(id)}
                    >
                      {t('detach')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Column>
        </div>
        <DragOverlay>
          {activeEntry ? (
            <div className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs shadow-lg">
              <span className="font-medium">{activeEntry.name}</span>
              <code className="ml-1 font-mono text-[10px] text-neutral-500">
                {activeEntry.id}
              </code>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

interface OrderedRow {
  readonly id: string;
  readonly depth: number;
  readonly parentSatisfied: boolean;
}

function groupByDependency(
  ids: readonly string[],
  catalog: Map<string, PluginCatalogEntryDto>,
  sameColumn: ReadonlySet<string>,
): OrderedRow[] {
  // A plugin is a child *of this column* if its first depends_on parent is
  // present in `sameColumn`. Otherwise it is a root in this column. Multi-
  // parent chains and grandchildren are collapsed onto two levels for
  // visual clarity — the goal is "show me what belongs together," not a
  // full graph view.
  const idSet = new Set(ids);
  const childrenByParent = new Map<string, string[]>();
  const roots: string[] = [];
  const parentSatisfaction = new Map<string, boolean>();

  for (const id of ids) {
    const entry = catalog.get(id);
    const deps = entry?.depends_on ?? [];
    const sameColParent = deps.find((p) => sameColumn.has(p));
    if (sameColParent && sameColParent !== id) {
      const list = childrenByParent.get(sameColParent) ?? [];
      list.push(id);
      childrenByParent.set(sameColParent, list);
      parentSatisfaction.set(id, true);
    } else {
      roots.push(id);
      // Unsatisfied if any depends_on parent exists at all but none in this column
      parentSatisfaction.set(id, deps.length === 0 || deps.some((p) => idSet.has(p)));
    }
  }

  const out: OrderedRow[] = [];
  for (const root of roots) {
    out.push({
      id: root,
      depth: 0,
      parentSatisfied: parentSatisfaction.get(root) ?? true,
    });
    const children = childrenByParent.get(root) ?? [];
    for (const child of children) {
      out.push({
        id: child,
        depth: 1,
        parentSatisfied: parentSatisfaction.get(child) ?? true,
      });
    }
  }
  return out;
}

function Column(props: {
  id: string;
  title: string;
  count: number;
  emptyLabel: string;
  children: React.ReactNode;
}): React.ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: props.id });
  const itemIds = useMemo(() => {
    // Used by SortableContext for keyboard nav; actual ordering comes
    // from the children prop the parent renders.
    return [props.id];
  }, [props.id]);

  return (
    <div
      ref={setNodeRef}
      className={[
        'rounded border bg-neutral-50/40 p-2 transition-colors',
        isOver
          ? 'border-sky-400 bg-sky-50/60'
          : 'border-neutral-200',
      ].join(' ')}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">
          {props.title}
        </span>
        <span className="text-[10px] text-neutral-500">{props.count}</span>
      </div>
      <SortableContext
        items={itemIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1.5">
          {props.count === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-neutral-400">
              {props.emptyLabel}
            </p>
          ) : (
            props.children
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function DraggablePluginTile(props: {
  entry: PluginCatalogEntryDto;
  depth: number;
  parentSatisfied: boolean;
  selection: SelectedEntry | null;
  disabled: boolean;
  expanded: boolean;
  onAttach: () => void;
  onDetach?: () => void;
  onToggleExpanded: () => void;
  onToggleEnabled: () => void;
  onSetConfigKey: (
    key: string,
    value: string | boolean | number | string[],
  ) => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const { entry } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    marginLeft: props.depth > 0 ? `${props.depth * 16}px` : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  const attached = props.selection !== null;
  const hasFields = entry.setup_fields.length > 0;
  const isStrict = entry.privacy_class === 'strict';

  return (
    <div ref={setNodeRef} style={style} className="select-none">
      <div className="rounded border border-neutral-200 bg-white">
        <div className="flex items-start gap-1.5 px-2 py-1.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="mt-0.5 cursor-grab text-neutral-400 hover:text-neutral-700 active:cursor-grabbing"
            title={t('dragHandle')}
            disabled={props.disabled}
          >
            <GripVertical size={14} />
          </button>
          <div className="flex-1 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-neutral-800">
                {entry.name}
              </span>
              <code className="font-mono text-[10px] text-neutral-500">
                {entry.id}
              </code>
              <KindBadge kind={entry.kind} />
              {!entry.multi_instance && (
                <span
                  title={
                    entry.multi_instance_justification ??
                    t('multiInstanceFalseBadge')
                  }
                  className="rounded bg-amber-100 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-800"
                >
                  {t('multiInstanceFalseShort')}
                </span>
              )}
              {isStrict && (
                <span className="rounded bg-violet-100 px-1.5 py-0 text-[10px] uppercase tracking-wide text-violet-800">
                  {t('privacyStrictBadge')}
                </span>
              )}
              {!props.parentSatisfied && entry.depends_on.length > 0 && (
                <span
                  title={t('dependencyMissingTooltip', {
                    parent: entry.depends_on[0] ?? '',
                  })}
                  className="rounded bg-rose-100 px-1.5 py-0 text-[10px] uppercase tracking-wide text-rose-800"
                >
                  {t('dependencyMissingBadge')}
                </span>
              )}
              {attached && (
                <label className="ml-auto flex items-center gap-1 text-[10px] text-neutral-600">
                  <input
                    type="checkbox"
                    checked={props.selection?.enabled ?? false}
                    disabled={props.disabled}
                    onChange={props.onToggleEnabled}
                  />
                  {t('enabledShort')}
                </label>
              )}
            </div>
            {(entry.memory_reads.length > 0 ||
              entry.memory_writes.length > 0) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {entry.memory_reads.map((s) => (
                  <span
                    key={`r-${s}`}
                    title={t('memoryReadTooltip')}
                    className="rounded bg-blue-50 px-1.5 py-0 text-[10px] text-blue-800"
                  >
                    r:{s}
                  </span>
                ))}
                {entry.memory_writes.map((s) => (
                  <span
                    key={`w-${s}`}
                    title={t('memoryWriteTooltip')}
                    className="rounded bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-800"
                  >
                    w:{s}
                  </span>
                ))}
              </div>
            )}
            {entry.network_outbound.length > 0 && (
              <p className="mt-1 truncate text-[10px] text-neutral-500">
                {t('networkLabel')} {entry.network_outbound.join(', ')}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            {!attached ? (
              <button
                type="button"
                className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[10px] hover:bg-neutral-100"
                disabled={props.disabled}
                onClick={props.onAttach}
              >
                {t('attach')}
              </button>
            ) : (
              <>
                {hasFields && (
                  <button
                    type="button"
                    onClick={props.onToggleExpanded}
                    className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[10px] hover:bg-neutral-100"
                  >
                    {props.expanded ? t('configHide') : t('configShow')}
                  </button>
                )}
                <button
                  type="button"
                  className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-800 hover:bg-red-100"
                  disabled={props.disabled}
                  onClick={props.onDetach}
                >
                  {t('detach')}
                </button>
              </>
            )}
          </div>
        </div>
        {attached && props.expanded && hasFields && (
          <PluginConfigForm
            fields={entry.setup_fields}
            values={props.selection?.config ?? {}}
            disabled={props.disabled}
            onChange={props.onSetConfigKey}
          />
        )}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }): React.ReactElement {
  const cls = {
    agent: 'bg-sky-100 text-sky-800',
    integration: 'bg-emerald-100 text-emerald-800',
    channel: 'bg-fuchsia-100 text-fuchsia-800',
    tool: 'bg-neutral-200 text-neutral-700',
    extension: 'bg-orange-100 text-orange-800',
  }[kind] ?? 'bg-neutral-200 text-neutral-700';
  return (
    <span
      className={`rounded px-1.5 py-0 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {kind}
    </span>
  );
}

function PluginConfigForm(props: {
  fields: readonly PluginSetupFieldDto[];
  values: Record<string, unknown>;
  disabled: boolean;
  onChange: (
    key: string,
    value: string | boolean | number | string[],
  ) => void;
}): React.ReactElement {
  return (
    <div className="border-t border-neutral-200 bg-neutral-50/50 px-3 py-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {props.fields.map((f) => (
          <PluginConfigField
            key={f.key}
            field={f}
            value={props.values[f.key]}
            disabled={props.disabled}
            onChange={(v) => props.onChange(f.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

function PluginConfigField(props: {
  field: PluginSetupFieldDto;
  value: unknown;
  disabled: boolean;
  onChange: (value: string | boolean | number | string[]) => void;
}): React.ReactElement {
  const { field, value, disabled, onChange } = props;
  const isSecret = field.type === 'secret' || field.type === 'password';
  const isHostList = field.type === 'host_list';
  const isEnum = field.type === 'enum' && (field.enum?.length ?? 0) > 0;
  const isBool = field.type === 'boolean';
  const isNumber = field.type === 'number';

  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">
        {field.label}
        {field.help && (
          <span className="ml-1 text-neutral-400">— {field.help}</span>
        )}
      </span>
      {isSecret ? (
        <input
          type="password"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
          placeholder={typeof field.default === 'string' ? field.default : ''}
        />
      ) : isEnum ? (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        >
          <option value="">—</option>
          {field.enum?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : isBool ? (
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1"
        />
      ) : isNumber ? (
        <input
          type="number"
          value={
            typeof value === 'number'
              ? value
              : value === undefined
                ? ''
                : Number(value)
          }
          disabled={disabled}
          onChange={(e) =>
            onChange(e.target.value === '' ? 0 : Number(e.target.value))
          }
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        />
      ) : isHostList ? (
        <textarea
          value={
            Array.isArray(value)
              ? value.join('\n')
              : typeof value === 'string'
                ? value
                : ''
          }
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            )
          }
          rows={3}
          placeholder="hostname.example.com"
          className="rounded border border-neutral-300 px-2 py-1 font-mono text-xs"
        />
      ) : (
        <input
          type={field.type === 'url' ? 'url' : 'text'}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={typeof field.default === 'string' ? field.default : ''}
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        />
      )}
    </label>
  );
}
