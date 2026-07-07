'use client';

import { useTranslations } from 'next-intl';

import type { AgentConsultation, SubAgentEvent, ToolEvent } from '../../_lib/chatSessions';

/** A single tool execution flattened for the consulted-trace view. */
interface TraceEntry {
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

interface AgentsConsultedFooterProps {
  agents: AgentConsultation[];
  /** This turn's tool events — used to attach a per-tool "stacktrace" (input +
   *  output/error) to each consulted entry when a match is found. */
  tools?: ToolEvent[];
  className?: string;
}

/**
 * #332 Layer 1 (gap-closure) — compact, tamper-evident footer showing which
 * sub-agent(s)/tool(s) were actually consulted this turn. Harness-sourced from
 * the deterministic run-trace (`Message.agentsConsulted`), never from the
 * orchestrator's own prose.
 *
 * Rendered as a collapsible list (default collapsed): expand to see the used
 * tools; each tool that maps to a real tool event expands again to reveal its
 * stacktrace (input + output/error). The label→tool match mirrors the backend
 * `normalizeKey` (directLine.ts) — same comparable key on both sides.
 */
export function AgentsConsultedFooter({
  agents,
  tools = [],
  className,
}: AgentsConsultedFooterProps): React.ReactElement | null {
  const t = useTranslations('directLine');
  const tChat = useTranslations('chat');
  if (agents.length === 0) return null;

  // Flatten this turn's tool executions — top-level calls AND the nested
  // sub-agent tool calls (paired tool_use + tool_result) — into trace entries,
  // then key them so a consulted label resolves to its actual stacktrace even
  // when the real call happened inside a sub-agent (not in message.tools).
  const byKey = new Map<string, TraceEntry[]>();
  const push = (entry: TraceEntry): void => {
    const key = consultedKey(entry.name);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(entry);
    else byKey.set(key, [entry]);
  };
  for (const tool of tools) {
    push({ name: tool.name, input: tool.input, output: tool.output, isError: tool.isError });
    for (const entry of pairSubEvents(tool.subEvents ?? [])) push(entry);
  }
  const traceFor = (agent: AgentConsultation): TraceEntry | undefined => {
    const key = consultedKey(agent.agentId ?? agent.label);
    return byKey.get(key)?.shift();
  };

  return (
    <details className={['group mt-2 text-[11px]', className ?? ''].join(' ')}>
      <summary className="flex cursor-pointer items-center gap-1.5 select-none text-[color:var(--fg-subtle)]">
        <span className="transition-transform group-open:rotate-90">▸</span>
        <span>{t('consultedLabel')}</span>
        <span className="text-[color:var(--fg-muted)]">
          {t('consultedCount', { count: agents.length })}
        </span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1 border-l-2 border-[color:var(--border)] pl-2">
        {agents.map((a, i) => {
          const trace = traceFor(a);
          const ok = a.status === 'success';
          const head = (
            <>
              <span aria-hidden="true">{ok ? '✓' : '✗'}</span>
              <span className="font-medium">{a.label}</span>
              {typeof a.toolCalls === 'number' && a.toolCalls > 0 && (
                <span className="text-[color:var(--fg-subtle)]">
                  · {t('stepsCount', { count: a.toolCalls })}
                </span>
              )}
            </>
          );
          const tone = ok
            ? 'text-[color:var(--success)]'
            : 'text-[color:var(--danger)]';
          if (!trace) {
            return (
              <li
                key={`${a.agentId ?? a.label}-${String(i)}`}
                className={['flex items-center gap-1.5', tone].join(' ')}
              >
                {head}
              </li>
            );
          }
          return (
            <li key={`${a.agentId ?? a.label}-${String(i)}`}>
              <details className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)]/60">
                <summary
                  className={[
                    'flex cursor-pointer items-center gap-1.5 px-1.5 py-0.5 select-none',
                    tone,
                  ].join(' ')}
                >
                  {head}
                  <span className="ml-auto text-[color:var(--fg-subtle)]">
                    {t('viewTrace')}
                  </span>
                </summary>
                <div className="border-t border-[color:var(--border)] px-2 py-1 font-mono text-[10px]">
                  <div className="text-[color:var(--fg-muted)]">
                    {tChat('inputLabel')}
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(trace.input ?? {}, null, 2)}
                  </pre>
                  {trace.output !== undefined && (
                    <>
                      <div className="mt-1 text-[color:var(--fg-muted)]">
                        {tChat('outputLabel')}
                      </div>
                      <pre
                        className={[
                          'max-h-64 overflow-auto whitespace-pre-wrap',
                          trace.isError ? 'text-[color:var(--danger)]' : '',
                        ].join(' ')}
                      >
                        {trace.output}
                      </pre>
                    </>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Frontend mirror of `normalizeKey` in harness-orchestrator/src/directLine.ts:
 *  reduce a label / agent id / tool name to a comparable lowercase-alnum key so
 *  a consulted entry's prettified label matches its raw tool event name. */
function consultedKey(value: string): string {
  const last = value.split(/[./]/).pop() ?? value;
  const deverbed = last.replace(/^(?:ask|consult|query|invoke|agent)[-_]/i, '');
  return deverbed.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pair a sub-agent's tool_use events with their tool_result by id, yielding one
 *  TraceEntry per completed sub-call (mirrors the SubTrace pairing in chat). */
function pairSubEvents(events: SubAgentEvent[]): TraceEntry[] {
  const byId = new Map<string, TraceEntry>();
  const order: TraceEntry[] = [];
  for (const e of events) {
    if (e.kind === 'tool_use') {
      const entry: TraceEntry = { name: e.name ?? '?', input: e.input };
      order.push(entry);
      if (e.id) byId.set(e.id, entry);
    } else if (e.kind === 'tool_result' && e.id) {
      const entry = byId.get(e.id);
      if (entry) {
        entry.output = e.output;
        entry.isError = e.isError;
      }
    }
  }
  return order;
}
