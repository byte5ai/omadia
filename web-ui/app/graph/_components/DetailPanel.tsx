'use client';

import {
  type GraphNode,
  type MemoryWithAncestors,
  type NodeType,
  type Tier,
  nodeColor,
  nodeIcon,
} from './graphTypes';
import MemoryAclSection from './MemoryAclSection';

interface Props {
  node: GraphNode;
  neighbors?: GraphNode[];
  onSelect: (node: GraphNode) => void;
  onExpand: (nodeId: string) => void;
  onClose: () => void;
  loadingNeighbors: boolean;
  /** Slice 3c — invoked when the user deletes the displayed MK so the
   *  parent can drop it from the selection / refresh. */
  onMemoryDeleted?: (nodeId: string) => void;
  /** Palaia Focused View — when the inspected node is a MK or
   *  PalaiaExcerpt and the parent has the matching `MemoryWithAncestors`
   *  row cached, render Lvl-1 / Lvl-2 provenance lists below the props. */
  provenance?: MemoryWithAncestors | null;
}

export default function DetailPanel({
  node,
  neighbors,
  onSelect,
  onExpand,
  onClose,
  loadingNeighbors,
  onMemoryDeleted,
  provenance = null,
}: Props): React.ReactElement {
  const propEntries = Object.entries(node.props).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-[color:var(--border)] bg-[color:var(--bg-elevated)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--border)] px-3 py-2 text-xs">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: nodeColor(node.type) }}
        />
        <span className="font-semibold">
          {nodeIcon(node.type)} {node.type}
        </span>
        {node.type === 'Turn' && node.tier ? (
          <TierBadge
            tier={node.tier}
            decayScore={node.decayScore}
            accessedAt={node.accessedAt}
            accessCount={node.accessCount}
          />
        ) : null}
        {node.type === 'Turn' && node.manuallyAuthored ? (
          <span
            className="rounded-full bg-[color:var(--warning)]/100/20 px-2 py-0.5 text-[10px] font-medium text-[color:var(--warning)]"
            title="manuell erfasst — Score-Boost ×1.3 im Token-Budget-Assembler"
          >
            ✎ manual
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[color:var(--border)] px-2 py-0.5 hover:border-[color:var(--border-strong)]"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        <div className="mb-3 break-all font-mono text-[10px] text-[color:var(--fg-muted)]">
          {node.id}
        </div>
        <div className="mb-3 flex flex-col gap-1">
          {propEntries.map(([k, v]) => (
            <div
              key={k}
              className="flex items-start gap-2 border-b border-[color:var(--border)] pb-1 last:border-0"
            >
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wide text-[color:var(--fg-subtle)]">
                {k}
              </span>
              <span className="min-w-0 break-words text-[color:var(--fg)]">
                {formatValue(v)}
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onExpand(node.id)}
          disabled={loadingNeighbors}
          className="w-full rounded border border-[color:var(--border)] px-2 py-1 text-[11px] font-semibold hover:border-[color:var(--border-strong)] disabled:opacity-50"
        >
          {loadingNeighbors ? 'lade Nachbarn…' : '↔ Nachbarn expandieren'}
        </button>

        {node.type === 'MemorableKnowledge' && (
          <MemoryAclSection
            memory={node}
            onDeleted={() => onMemoryDeleted?.(node.id)}
          />
        )}

        {provenance && (
          <ProvenanceSection node={node} provenance={provenance} onSelect={onSelect} />
        )}

        {neighbors && neighbors.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--fg-subtle)]">
              {neighbors.length} Nachbar{neighbors.length === 1 ? '' : 'n'}
            </div>
            <div className="flex flex-col gap-1">
              {neighbors.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelect(n)}
                  className="flex items-start gap-2 rounded border border-[color:var(--border)] px-2 py-1 text-left hover:border-[color:var(--border-strong)]"
                >
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: nodeColor(n.type) }}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-[10px] text-[color:var(--fg-muted)]">
                      {nodeIcon(n.type)} {n.type}
                    </span>
                    <span className="block truncate">
                      {String(
                        n.props['displayName'] ??
                          n.props['agentName'] ??
                          n.props['toolName'] ??
                          n.props['summary'] ??
                          n.props['text'] ??
                          n.props['userMessage'] ??
                          n.id,
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 400 ? `${v.slice(0, 400)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function TierBadge({
  tier,
  decayScore,
  accessedAt,
  accessCount,
}: {
  tier: Tier;
  decayScore?: number;
  accessedAt?: string | null;
  accessCount?: number;
}): React.ReactElement {
  const palette: Record<Tier, string> = {
    HOT: 'bg-[color:var(--accent)]/100/20 text-[color:var(--accent)]',
    WARM: 'bg-[color:var(--warning)]/100/20 text-[color:var(--warning)]',
    COLD: 'bg-[color:var(--fg-subtle)]/20 text-[color:var(--fg-muted)]',
  };
  const tooltipParts: string[] = [`tier=${tier}`];
  if (typeof decayScore === 'number') {
    tooltipParts.push(`decay=${decayScore.toFixed(3)}`);
  }
  if (typeof accessCount === 'number') {
    tooltipParts.push(`access_count=${String(accessCount)}`);
  }
  if (typeof accessedAt === 'string' && accessedAt.length > 0) {
    tooltipParts.push(`accessed_at=${accessedAt}`);
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${palette[tier]}`}
      title={tooltipParts.join(' · ')}
    >
      {tier}
    </span>
  );
}

function ProvenanceSection({
  node,
  provenance,
  onSelect,
}: {
  node: GraphNode;
  provenance: MemoryWithAncestors;
  onSelect: (n: GraphNode) => void;
}): React.ReactElement | null {
  if (node.type !== 'MemorableKnowledge' && node.type !== 'PalaiaExcerpt') {
    return null;
  }
  const lvl1Label =
    node.type === 'MemorableKnowledge'
      ? 'Lvl 1 · Turn / User / Entitäten'
      : 'Lvl 1 · Parent-Memory';
  const lvl2Label =
    node.type === 'MemorableKnowledge'
      ? 'Lvl 2 · Session'
      : 'Lvl 2 · Turn / User / Entitäten';
  return (
    <div className="mt-3 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent)]">
        Provenance (2 Hops)
      </div>
      <ProvenanceList label={lvl1Label} nodes={provenance.level1} onSelect={onSelect} />
      <ProvenanceList label={lvl2Label} nodes={provenance.level2} onSelect={onSelect} />
    </div>
  );
}

function ProvenanceList({
  label,
  nodes,
  onSelect,
}: {
  label: string;
  nodes: GraphNode[];
  onSelect: (n: GraphNode) => void;
}): React.ReactElement {
  if (nodes.length === 0) {
    return (
      <div className="mt-1">
        <div className="text-[10px] uppercase tracking-wide text-[color:var(--fg-subtle)]">
          {label}
        </div>
        <div className="text-[11px] italic text-[color:var(--fg-subtle)]">keine</div>
      </div>
    );
  }
  return (
    <div className="mt-1">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--fg-subtle)]">
        {label}
      </div>
      <div className="mt-1 flex flex-col gap-1">
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onSelect(n)}
            className="flex items-start gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1 text-left hover:border-[color:var(--accent)]"
          >
            <span
              className="mt-1 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: nodeColor(n.type) }}
            />
            <span className="min-w-0">
              <span className="block font-mono text-[10px] text-[color:var(--fg-muted)]">
                {nodeIcon(n.type)} {n.type}
              </span>
              <span className="block truncate">
                {String(
                  n.props['displayName'] ??
                    n.props['summary'] ??
                    n.props['scope'] ??
                    n.props['text'] ??
                    n.props['userMessage'] ??
                    n.id,
                )}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export type { NodeType };
