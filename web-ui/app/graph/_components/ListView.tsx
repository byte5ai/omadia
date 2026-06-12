'use client';

import { useState } from 'react';
import type {
  GraphNode,
  NodeType,
  RunAgentInvocationView,
  RunToolCallView,
  RunTraceView,
  SessionView,
} from './graphTypes';

interface Props {
  view: SessionView;
  runCache: Record<string, RunTraceView | 'loading' | 'missing'>;
  onEntityClick: (id: string) => void;
  onLoadRun: (turnId: string) => void;
}

export default function ListView({
  view,
  runCache,
  onEntityClick,
  onLoadRun,
}: Props): React.ReactElement {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
      <div className="flex flex-col gap-3">
        {view.turns.map((t) => (
          <TurnCard
            key={t.turn.id}
            turn={t.turn}
            entities={t.entities}
            onEntityClick={onEntityClick}
            runState={runCache[t.turn.id]}
            onLoadRun={() => onLoadRun(t.turn.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TurnCard({
  turn,
  entities,
  onEntityClick,
  runState,
  onLoadRun,
}: {
  turn: GraphNode;
  entities: GraphNode[];
  onEntityClick: (id: string) => void;
  runState: RunTraceView | 'loading' | 'missing' | undefined;
  onLoadRun: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const time = String(turn.props['time'] ?? '')
    .replace('T', ' ')
    .slice(0, 19);
  const user = String(turn.props['userMessage'] ?? '');
  const tools = turn.props['toolCalls'];

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && !runState) onLoadRun();
  };

  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 text-sm shadow-sm">
      <div className="mb-2 flex items-center gap-3 text-[11px] text-[color:var(--fg-muted)]">
        <span className="font-mono">{time}</span>
        {tools !== undefined && <span>tools={String(tools)}</span>}
        <button
          type="button"
          onClick={toggle}
          className="ml-auto rounded border border-[color:var(--border)] px-2 py-0.5 font-mono hover:border-[color:var(--border-strong)]"
        >
          {open ? '▾' : '▸'} Run-Trace
        </button>
      </div>
      <div className="mb-2 whitespace-pre-wrap text-[color:var(--fg)]">
        {user}
      </div>
      {entities.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {entities.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onEntityClick(e.id)}
              className={[
                'rounded-full px-2 py-0.5 font-mono text-[11px] transition',
                e.type === 'ConfluencePage'
                  ? 'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-1 ring-[color:var(--accent)] hover:bg-[color:var(--accent)]/10'
                  : 'bg-[color:var(--success)]/10 text-[color:var(--success)] ring-1 ring-[color:var(--success)] hover:bg-[color:var(--success)]/10',
              ].join(' ')}
              title={e.id}
            >
              {String(e.props['displayName'] ?? e.props['externalId'] ?? e.id)}
            </button>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-[color:var(--fg-subtle)]">
          keine Entities in diesem Turn
        </div>
      )}
      {open && (
        <div className="mt-3 border-t border-[color:var(--border)] pt-3">
          {runState === 'loading' && (
            <div className="text-[11px] text-[color:var(--fg-muted)]">lade Run…</div>
          )}
          {runState === 'missing' && (
            <div className="text-[11px] text-[color:var(--fg-muted)]">
              keine Run-Trace erfasst
            </div>
          )}
          {runState && runState !== 'loading' && runState !== 'missing' && (
            <RunTracePanel run={runState} onEntityClick={onEntityClick} />
          )}
        </div>
      )}
    </div>
  );
}

function RunTracePanel({
  run,
  onEntityClick,
}: {
  run: RunTraceView;
  onEntityClick: (id: string) => void;
}): React.ReactElement {
  const status = String(run.run.props['status'] ?? 'unknown');
  const duration = Number(run.run.props['durationMs'] ?? 0);
  const iterations = Number(run.run.props['iterations'] ?? 0);
  const user = run.user ? String(run.user.props['userId'] ?? '') : null;

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2 font-mono text-[11px] text-[color:var(--fg-muted)]">
        <StatusPill status={status} />
        <span>{formatMs(duration)}</span>
        <span>·</span>
        <span>{iterations} iter</span>
        {user && (
          <>
            <span>·</span>
            <span title={`User: ${user}`}>👤 {user.slice(0, 16)}</span>
          </>
        )}
      </div>

      {run.orchestratorToolCalls.length > 0 && (
        <div className="flex flex-col gap-1 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--fg-subtle)]">
            Orchestrator-Tools
          </div>
          {run.orchestratorToolCalls.map((tc) => (
            <ToolCallRow
              key={tc.node.id}
              tc={tc}
              onEntityClick={onEntityClick}
            />
          ))}
        </div>
      )}

      {run.agentInvocations.map((inv: RunAgentInvocationView) => {
        const agentName = String(inv.node.props['agentName'] ?? inv.node.id);
        const invStatus = String(inv.node.props['status'] ?? 'unknown');
        const invDur = Number(inv.node.props['durationMs'] ?? 0);
        const subIter = Number(inv.node.props['subIterations'] ?? 0);
        return (
          <div
            key={inv.node.id}
            className={[
              'flex flex-col gap-1 rounded border p-2',
              invStatus === 'error'
                ? 'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8'
                : 'border-[color:var(--success)] bg-[color:var(--success)]/10',
            ].join(' ')}
          >
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <StatusPill status={invStatus} />
              <span className="font-semibold">🤖 {agentName}</span>
              <span className="text-[color:var(--fg-muted)]">{formatMs(invDur)}</span>
              <span className="text-[color:var(--fg-muted)]">·</span>
              <span className="text-[color:var(--fg-muted)]">{subIter} iter</span>
              <span className="text-[color:var(--fg-muted)]">·</span>
              <span className="text-[color:var(--fg-muted)]">
                {inv.toolCalls.length} tool-call
                {inv.toolCalls.length === 1 ? '' : 's'}
              </span>
            </div>
            {inv.toolCalls.length > 0 && (
              <div className="flex flex-col gap-0.5 pl-4">
                {inv.toolCalls.map((tc) => (
                  <ToolCallRow
                    key={tc.node.id}
                    tc={tc}
                    onEntityClick={onEntityClick}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {run.orchestratorToolCalls.length === 0 &&
        run.agentInvocations.length === 0 && (
          <div className="text-[11px] italic text-[color:var(--fg-subtle)]">
            Run ohne Tool-Calls (reine Textantwort)
          </div>
        )}
    </div>
  );
}

function ToolCallRow({
  tc,
  onEntityClick,
}: {
  tc: RunToolCallView;
  onEntityClick: (id: string) => void;
}): React.ReactElement {
  const toolName = String(tc.node.props['toolName'] ?? '?');
  const durationMs = Number(tc.node.props['durationMs'] ?? 0);
  const isError = tc.node.props['isError'] === true;
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <span
        className={
          isError ? 'text-[color:var(--danger)]' : 'text-[color:var(--fg)]'
        }
      >
        {isError ? '⚠' : '🔧'} {toolName}
      </span>
      <span className="text-[color:var(--fg-muted)]">{formatMs(durationMs)}</span>
      {tc.producedEntities.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-[color:var(--fg-subtle)]">↳</span>
          {tc.producedEntities.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onEntityClick(e.id)}
              className="rounded bg-[color:var(--success)]/10 px-2 py-0.5 text-[color:var(--success)] ring-1 ring-[color:var(--success)] hover:bg-[color:var(--success)]/10"
              title={e.id}
            >
              {String(e.props['displayName'] ?? e.id)}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }): React.ReactElement {
  if (status === 'success') {
    return (
      <span className="rounded bg-[color:var(--success)]/10 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--success)]">
        OK
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="rounded bg-[color:var(--danger)]/8 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--danger)]">
        FAIL
      </span>
    );
  }
  return (
    <span className="rounded bg-[color:var(--state-loading)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--fg)]">
      {status}
    </span>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function typeIcon(type: NodeType): string {
  switch (type) {
    case 'Session':
      return '📂';
    case 'Turn':
      return '💬';
    case 'OdooEntity':
      return '🏷';
    case 'ConfluencePage':
      return '📄';
    case 'User':
      return '👤';
    case 'Run':
      return '▶';
    case 'AgentInvocation':
      return '🤖';
    case 'ToolCall':
      return '🔧';
    default:
      return '•';
  }
}
