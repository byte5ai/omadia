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
    <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-800">
      <div className="mb-2 flex items-center gap-3 text-[11px] text-neutral-500">
        <span className="font-mono">{time}</span>
        {tools !== undefined && <span>tools={String(tools)}</span>}
        <button
          type="button"
          onClick={toggle}
          className="ml-auto rounded border border-neutral-300 px-2 py-0.5 font-mono hover:border-neutral-400 dark:border-neutral-700"
        >
          {open ? '▾' : '▸'} Run-Trace
        </button>
      </div>
      <div className="mb-2 whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">
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
                  ? 'bg-blue-50 text-blue-900 ring-1 ring-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-100 dark:ring-blue-800'
                  : 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-100 dark:ring-emerald-800',
              ].join(' ')}
              title={e.id}
            >
              {String(e.props['displayName'] ?? e.props['externalId'] ?? e.id)}
            </button>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-neutral-400">
          keine Entities in diesem Turn
        </div>
      )}
      {open && (
        <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-700">
          {runState === 'loading' && (
            <div className="text-[11px] text-neutral-500">lade Run…</div>
          )}
          {runState === 'missing' && (
            <div className="text-[11px] text-neutral-500">
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
      <div className="flex items-center gap-2 font-mono text-[11px] text-neutral-500">
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
        <div className="flex flex-col gap-1 rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-900/40">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
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
                ? 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-900/20'
                : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-900/20',
            ].join(' ')}
          >
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <StatusPill status={invStatus} />
              <span className="font-semibold">🤖 {agentName}</span>
              <span className="text-neutral-500">{formatMs(invDur)}</span>
              <span className="text-neutral-500">·</span>
              <span className="text-neutral-500">{subIter} iter</span>
              <span className="text-neutral-500">·</span>
              <span className="text-neutral-500">
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
          <div className="text-[11px] italic text-neutral-400">
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
          isError ? 'text-red-600' : 'text-neutral-700 dark:text-neutral-300'
        }
      >
        {isError ? '⚠' : '🔧'} {toolName}
      </span>
      <span className="text-neutral-500">{formatMs(durationMs)}</span>
      {tc.producedEntities.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-neutral-400">↳</span>
          {tc.producedEntities.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onEntityClick(e.id)}
              className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-900 ring-1 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-100 dark:ring-emerald-800"
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
      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100">
        OK
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-900 dark:bg-red-900/50 dark:text-red-100">
        FAIL
      </span>
    );
  }
  return (
    <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
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
