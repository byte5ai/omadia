'use client';

import {
  type GraphNode,
  type NodeType,
  type Tier,
  nodeColor,
  nodeIcon,
} from './graphTypes';

interface Props {
  node: GraphNode;
  neighbors?: GraphNode[];
  onSelect: (node: GraphNode) => void;
  onExpand: (nodeId: string) => void;
  onClose: () => void;
  loadingNeighbors: boolean;
}

export default function DetailPanel({
  node,
  neighbors,
  onSelect,
  onExpand,
  onClose,
  loadingNeighbors,
}: Props): React.ReactElement {
  const propEntries = Object.entries(node.props).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
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
            className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="manuell erfasst — Score-Boost ×1.3 im Token-Budget-Assembler"
          >
            ✎ manual
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-neutral-300 px-2 py-0.5 hover:border-neutral-400 dark:border-neutral-700"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        <div className="mb-3 break-all font-mono text-[10px] text-neutral-500">
          {node.id}
        </div>
        <div className="mb-3 flex flex-col gap-1">
          {propEntries.map(([k, v]) => (
            <div
              key={k}
              className="flex items-start gap-2 border-b border-neutral-100 pb-1 last:border-0 dark:border-neutral-800"
            >
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wide text-neutral-400">
                {k}
              </span>
              <span className="min-w-0 break-words text-neutral-700 dark:text-neutral-300">
                {formatValue(v)}
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onExpand(node.id)}
          disabled={loadingNeighbors}
          className="w-full rounded border border-neutral-300 px-2 py-1 text-[11px] font-semibold hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
        >
          {loadingNeighbors ? 'lade Nachbarn…' : '↔ Nachbarn expandieren'}
        </button>

        {neighbors && neighbors.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              {neighbors.length} Nachbar{neighbors.length === 1 ? '' : 'n'}
            </div>
            <div className="flex flex-col gap-1">
              {neighbors.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelect(n)}
                  className="flex items-start gap-2 rounded border border-neutral-200 px-2 py-1 text-left hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
                >
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: nodeColor(n.type) }}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-[10px] text-neutral-500">
                      {nodeIcon(n.type)} {n.type}
                    </span>
                    <span className="block truncate">
                      {String(
                        n.props['displayName'] ??
                          n.props['agentName'] ??
                          n.props['toolName'] ??
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
    HOT: 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-400',
    WARM: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
    COLD: 'bg-neutral-500/20 text-neutral-600 dark:text-neutral-400',
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

export type { NodeType };
