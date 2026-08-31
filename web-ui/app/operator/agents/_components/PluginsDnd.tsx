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

import { Button } from '@/app/_components/ui/Button';
import { countOverrides, PluginConfigModal } from './PluginConfigModal';
import type {
  OperatorAgentDto,
  PluginCatalogEntryDto,
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
  /**
   * Fallback Agents always run their plugins with the global store config
   * (the one set during plugin install). The per-(Agent × plugin) config
   * drawer is hidden + the saved config payload is wiped to `{}` before
   * the PUT so the server-side contract stays consistent: only NON-fallback
   * Agents may override.
   */
  readonly isFallback: boolean;
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
  // OM-27 — the shared count vocabulary lives under `store.page.counts` so the
  // store, the dashboard and this page phrase their three different numbers
  // from one catalogue.
  const tCounts = useTranslations('store.page.counts');
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
  // Orphan ids the operator explicitly chose to KEEP across saves — used to
  // override the "drop orphans on save" default for rows that are still
  // meaningful (e.g. a plugin that is temporarily uninstalled but coming
  // back). Default empty; operator opts in per orphan.
  const [keptOrphans, setKeptOrphans] = useState<Set<string>>(new Set());

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

    if (toContainer === ENABLED_ID) {
      attach(activeId);
    } else if (toContainer === AVAILABLE_ID) {
      detach(activeId);
    }
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

  /**
   * Attaching a plugin transitively pulls in every `depends_on` parent.
   * Without that, attaching a child fails at save time: the orchestrator
   * crashloops the plugin because the parent's secrets/config it inherits
   * from are unreachable. The user's feedback was explicit — "Child → Dep
   * automatisch mit installieren."
   *
   * Walked breadth-first so a chain of grandparents is added one go.
   * Already-attached parents are left as-is (no overwrite of their config).
   * Parents outside the catalog (manifest-less plugin) are silently
   * skipped so an orphan dependency cannot block the attach.
   */
  function attach(id: string): void {
    setSelected((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      const queue: string[] = [id];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur || seen.has(cur)) continue;
        seen.add(cur);
        if (!next.has(cur)) {
          next.set(cur, { enabled: true, config: {} });
        }
        const entry = catalogById.get(cur);
        for (const dep of entry?.depends_on ?? []) {
          if (!next.has(dep) && catalogById.has(dep)) queue.push(dep);
        }
      }
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

  /**
   * Drop one key from the per-orchestrator override map so the plugin falls
   * back to the store-level install config for that field. Deleting is not the
   * same as writing `''` — the server treats a present key as an override.
   */
  function resetConfigKey(pluginId: string, fieldKey: string): void {
    setSelected((prev) => {
      const cur = prev.get(pluginId);
      if (!cur) return prev;
      const next = new Map(prev);
      const config = { ...cur.config };
      delete config[fieldKey];
      next.set(pluginId, { ...cur, config });
      return next;
    });
  }

  function resetPluginConfig(pluginId: string): void {
    setSelected((prev) => {
      const cur = prev.get(pluginId);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(pluginId, { ...cur, config: {} });
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
      // Drop orphan rows on save: an `agent_plugins` row whose id is not in
      // the current installed-plugin catalog is almost always a leftover
      // from a renamed/uninstalled plugin (de.byte5.agent.* → @omadia/*).
      // Letting them stay around makes them re-upsert on every PUT, which
      // is why "STALE" used to grow on each rehydrate. The operator can
      // still toggle them back in via the "Keep" checkbox on each orphan.
      if (!catalogById.has(id) && !keptOrphans.has(id)) continue;
      // Fallback contract: per-Agent config is meaningless on the fallback
      // — wipe to {} so the server never has to second-guess which copy
      // wins. Non-fallback Agents persist whatever the operator entered.
      const config = props.isFallback ? {} : entry.config;
      out.push({ id, enabled: entry.enabled, config });
    }
    props.onReplace(out);
  }

  function clearAllOrphans(): void {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!catalogById.has(id)) next.delete(id);
      }
      return next;
    });
    setKeptOrphans(new Set());
  }

  function toggleKeepOrphan(id: string): void {
    setKeptOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeEntry = activeId ? catalogById.get(activeId) : undefined;
  // The config dialog is per-(orchestrator × plugin) and therefore meaningless
  // on the fallback, which always runs the store config — `storeConfigOnly`
  // already hides the trigger, this keeps a stale `expanded` id from reopening
  // it if the agent becomes the fallback while the page is mounted.
  const configEntry =
    expanded && !props.isFallback ? catalogById.get(expanded) : undefined;
  const configSelection = configEntry
    ? selected.get(configEntry.id)
    : undefined;

  return (
    <div>
      <h4 className="mb-2 flex items-center justify-between text-sm font-medium">
        {t('pluginsHeading')}
        <Button
          variant="secondary"
          size="sm"
          disabled={props.disabled}
          onClick={submit}
        >
          {t('save')}
        </Button>
      </h4>
      {/* OM-27 — these numbers count ATTACHMENT to this orchestrator, not
          installation. The store tab and the dashboard tile count installed
          plugins; spelling the difference out here stops the three from
          reading as one inconsistent number. */}
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
        {tCounts('attached', {
          n: enabledOrdered.length + orphans.length,
          agent: props.agent.name,
        })}
        {' · '}
        {tCounts('available', { n: availableOrdered.length })}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Column
            id={AVAILABLE_ID}
            title={t('pluginsAvailableToAttach')}
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
                  storeConfigOnly={props.isFallback}
                  disabled={props.disabled}
                  onAttach={() => attach(row.id)}
                  overrideCount={0}
                  onOpenConfig={() => undefined}
                  onToggleEnabled={() => undefined}
                />
              );
            })}
          </Column>

          <Column
            id={ENABLED_ID}
            title={t('pluginsAttachedHere')}
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
                  storeConfigOnly={props.isFallback}
                  disabled={props.disabled}
                  onAttach={() => undefined}
                  overrideCount={countOverrides(
                    entry.setup_fields,
                    selection.config,
                  )}
                  onOpenConfig={() => setExpanded(row.id)}
                  onToggleEnabled={() => toggleEnabled(row.id)}
                  onDetach={() => detach(row.id)}
                />
              );
            })}
            {orphans.length > 0 && (
              <div className="mt-3 border-t border-[color:var(--warning)] pt-2">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wide text-[color:var(--warning)]">
                    {t('orphanPluginsHeading')} ({orphans.length})
                  </p>
                  {/* eslint-disable-next-line no-restricted-syntax -- warning-outline orphan detach-all action (§10 no warning variant) */}
                  <button
                    type="button"
                    className="rounded border border-[color:var(--warning)] bg-[color:var(--bg-elevated)] px-2 py-0 text-[10px] text-[color:var(--warning)] hover:bg-[color:var(--warning)]/10"
                    disabled={props.disabled}
                    onClick={clearAllOrphans}
                    title={t('orphanDetachAllTooltip')}
                  >
                    {t('orphanDetachAll')}
                  </button>
                </div>
                <p className="mb-2 text-[10px] text-[color:var(--warning)]">
                  {t('orphanExplain')}
                </p>
                {orphans.map((id) => (
                  <div
                    key={id}
                    className="mb-1 flex items-center gap-2 rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 px-2 py-1 text-xs"
                  >
                    <label className="flex items-center gap-1 text-[10px] text-[color:var(--warning)]">
                      <input
                        type="checkbox"
                        checked={keptOrphans.has(id)}
                        disabled={props.disabled}
                        onChange={() => toggleKeepOrphan(id)}
                      />
                      {t('orphanKeep')}
                    </label>
                    <span className="font-mono text-[color:var(--warning)]">{id}</span>
                    <span className="text-[10px] uppercase text-[color:var(--warning)]">
                      {t('orphanPluginBadge')}
                    </span>
                    {/* eslint-disable-next-line no-restricted-syntax -- warning-outline per-orphan detach action (§10 no warning variant) */}
                    <button
                      type="button"
                      className="ml-auto rounded border border-[color:var(--warning)] bg-[color:var(--bg-elevated)] px-2 py-0 text-[10px] hover:bg-[color:var(--warning)]/10"
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
            <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-2 text-xs shadow-lg">
              <span className="font-medium">{activeEntry.name}</span>
              <code className="ml-1 font-mono text-[10px] text-[color:var(--fg-muted)]">
                {activeEntry.id}
              </code>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {/* Rendered at the root, not inside the tile: a dialog nested in a
          `useSortable` node inherits the drag transform and the column's
          overflow, which clipped it and let a pointer-down on an input start
          a drag. */}
      {configEntry && configSelection && (
        <PluginConfigModal
          entry={configEntry}
          values={configSelection.config}
          disabled={props.disabled}
          onChange={(fk, v) => setConfigKey(configEntry.id, fk, v)}
          onReset={(fk) => resetConfigKey(configEntry.id, fk)}
          onResetAll={() => resetPluginConfig(configEntry.id)}
          onClose={() => setExpanded(null)}
        />
      )}
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
        'rounded border bg-[color:var(--bg-soft)]/40 p-2 transition-colors',
        isOver
          ? 'border-dashed border-[color:var(--accent)] bg-[color:var(--accent)]/10'
          : 'border-[color:var(--border)]',
      ].join(' ')}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
          {props.title}
        </span>
        <span className="text-[10px] text-[color:var(--fg-muted)]">{props.count}</span>
      </div>
      <SortableContext
        items={itemIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-2">
          {props.count === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-[color:var(--fg-subtle)]">
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
  /** Hide the per-plugin config drawer when the parent Agent is the
   *  fallback — fallback always uses the store-config. */
  storeConfigOnly: boolean;
  disabled: boolean;
  /** How many setup fields this orchestrator overrides — 0 = pure store config. */
  overrideCount: number;
  onAttach: () => void;
  onDetach?: () => void;
  onOpenConfig: () => void;
  onToggleEnabled: () => void;
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
    opacity: isDragging ? 0.5 : 1,
    boxShadow: isDragging ? 'var(--shadow-drag)' : undefined,
  };

  const attached = props.selection !== null;
  const hasFields = entry.setup_fields.length > 0 && !props.storeConfigOnly;
  const isStrict = entry.privacy_class === 'strict';

  return (
    <div ref={setNodeRef} style={style} className="select-none">
      <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)]">
        <div className="flex items-start gap-2 px-2 py-2">
          {/* eslint-disable-next-line no-restricted-syntax -- dnd drag handle (icon-only GripVertical + drag listeners), not a §4.2 CTA */}
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="mt-0.5 cursor-grab text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)] active:cursor-grabbing"
            title={t('dragHandle')}
            disabled={props.disabled}
          >
            <GripVertical size={14} />
          </button>
          <div className="flex-1 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-[color:var(--fg)]">
                {entry.name}
              </span>
              <code className="font-mono text-[10px] text-[color:var(--fg-muted)]">
                {entry.id}
              </code>
              <KindBadge kind={entry.kind} />
              {!entry.multi_instance && (
                <span
                  title={
                    entry.multi_instance_justification ??
                    t('multiInstanceFalseBadge')
                  }
                  className="rounded bg-[color:var(--warning)]/10 px-2 py-0 text-[10px] uppercase tracking-wide text-[color:var(--warning)]"
                >
                  {t('multiInstanceFalseShort')}
                </span>
              )}
              {isStrict && (
                <span className="rounded bg-[color:var(--accent)]/10 px-2 py-0 text-[10px] uppercase tracking-wide text-[color:var(--accent)]">
                  {t('privacyStrictBadge')}
                </span>
              )}
              {!props.parentSatisfied && entry.depends_on.length > 0 && (
                <span
                  title={t('dependencyMissingTooltip', {
                    parent: entry.depends_on[0] ?? '',
                  })}
                  className="rounded bg-[color:var(--danger)]/8 px-2 py-0 text-[10px] uppercase tracking-wide text-[color:var(--danger)]"
                >
                  {t('dependencyMissingBadge')}
                </span>
              )}
              {attached && (
                <label className="ml-auto flex items-center gap-1 text-[10px] text-[color:var(--fg-muted)]">
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
                    className="rounded bg-[color:var(--accent)]/10 px-2 py-0 text-[10px] text-[color:var(--accent)]"
                  >
                    r:{s}
                  </span>
                ))}
                {entry.memory_writes.map((s) => (
                  <span
                    key={`w-${s}`}
                    title={t('memoryWriteTooltip')}
                    className="rounded bg-[color:var(--success)]/10 px-2 py-0 text-[10px] text-[color:var(--success)]"
                  >
                    w:{s}
                  </span>
                ))}
              </div>
            )}
            {entry.network_outbound.length > 0 && (
              <p className="mt-1 truncate text-[10px] text-[color:var(--fg-muted)]">
                {t('networkLabel')} {entry.network_outbound.join(', ')}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            {!attached ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={props.disabled}
                onClick={props.onAttach}
              >
                {t('attach')}
              </Button>
            ) : (
              <>
                {hasFields && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={props.onOpenConfig}
                  >
                    {t('configShow')}
                    {props.overrideCount > 0 && (
                      <span
                        title={t('configOverrideBadgeTooltip')}
                        className="rounded bg-[color:var(--accent)]/12 px-1.5 text-[10px] font-semibold text-[color:var(--accent)]"
                      >
                        {props.overrideCount}
                      </span>
                    )}
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={props.disabled}
                  onClick={props.onDetach}
                >
                  {t('detach')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }): React.ReactElement {
  const cls = {
    agent: 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
    integration: 'bg-[color:var(--success)]/10 text-[color:var(--success)]',
    channel: 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
    tool: 'bg-[color:var(--state-loading)] text-[color:var(--fg)]',
    extension: 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  }[kind] ?? 'bg-[color:var(--state-loading)] text-[color:var(--fg)]';
  return (
    <span
      className={`rounded px-2 py-0 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {kind}
    </span>
  );
}
