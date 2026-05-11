'use client';

import { useState } from 'react';

interface Props {
  trace: unknown;
}

/**
 * Compact collapsible JSON-tree for the run-trace blob. Self-contained —
 * no external dep — because the structure is well-defined (RunTracePayload
 * with `iterations`, `orchestratorToolCalls`, `agentInvocations`) and a
 * generic JSON viewer would render it less readably.
 *
 * Strategy:
 *   - Objects + arrays render as a `▸ Label` toggle line; expanded shows
 *     children indented one level.
 *   - Primitives render as a colored value next to the key.
 *   - Strings longer than 200 chars are truncated with a "more"/"less"
 *     toggle so a 4kb tool-call result doesn't blow the layout.
 *
 * Defaults: top-level objects start expanded; nested arrays/objects start
 * collapsed. Shift-click on a toggle expands / collapses every direct
 * child too (cheap recursion via `defaultExpanded` prop forwarding).
 */
export function RunTraceViewer({ trace }: Props): React.ReactElement {
  if (trace === null || trace === undefined) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-4 text-[12px] text-[color:var(--fg-subtle)]">
        Kein Run-Trace verfügbar (typisch bei Errors vor `runTurn` oder bei
        älteren Runs vor Aktivierung der Trace-Persistierung).
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-4 font-mono text-[12px] leading-[1.5]">
      <JsonNode value={trace} keyName="trace" depth={0} defaultExpanded />
    </div>
  );
}

function JsonNode({
  value,
  keyName,
  depth,
  defaultExpanded = false,
}: {
  value: unknown;
  keyName: string | null;
  depth: number;
  defaultExpanded?: boolean;
}): React.ReactElement {
  if (value === null) return <PrimitiveLine keyName={keyName} display="null" tone="muted" />;
  if (value === undefined)
    return <PrimitiveLine keyName={keyName} display="undefined" tone="muted" />;

  const t = typeof value;
  if (t === 'string') {
    return <StringLine keyName={keyName} value={value as string} />;
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') {
    return (
      <PrimitiveLine
        keyName={keyName}
        display={String(value)}
        tone={t === 'number' ? 'num' : 'bool'}
      />
    );
  }
  if (Array.isArray(value)) {
    return (
      <CollapsibleNode
        keyName={keyName}
        previewLabel={`[ ${value.length} ]`}
        defaultExpanded={defaultExpanded || depth === 0}
        depth={depth}
      >
        {value.map((item, idx) => (
          <JsonNode
             
            key={idx}
            value={item}
            keyName={String(idx)}
            depth={depth + 1}
          />
        ))}
      </CollapsibleNode>
    );
  }
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <CollapsibleNode
        keyName={keyName}
        previewLabel={`{ ${entries.length} }`}
        defaultExpanded={defaultExpanded || depth === 0}
        depth={depth}
      >
        {entries.map(([k, v]) => (
          <JsonNode key={k} value={v} keyName={k} depth={depth + 1} />
        ))}
      </CollapsibleNode>
    );
  }
  return (
    <PrimitiveLine
      keyName={keyName}
      display={`<${t}>`}
      tone="muted"
    />
  );
}

function CollapsibleNode({
  keyName,
  previewLabel,
  defaultExpanded,
  depth,
  children,
}: {
  keyName: string | null;
  previewLabel: string;
  defaultExpanded: boolean;
  depth: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
      <button
        type="button"
        onClick={(): void => setExpanded((v) => !v)}
        className="inline-flex items-baseline gap-1 text-left transition hover:text-[color:var(--accent)]"
      >
        <span
          aria-hidden="true"
          className="text-[color:var(--fg-subtle)]"
          style={{ minWidth: 12, display: 'inline-block' }}
        >
          {expanded ? '▾' : '▸'}
        </span>
        {keyName !== null ? (
          <span className="text-[color:var(--accent)]">{keyName}</span>
        ) : null}
        {keyName !== null ? (
          <span className="text-[color:var(--fg-subtle)]">:</span>
        ) : null}
        <span className="text-[color:var(--fg-subtle)]">{previewLabel}</span>
      </button>
      {expanded ? (
        <div className="mt-0.5 border-l border-[color:var(--divider)] pl-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function PrimitiveLine({
  keyName,
  display,
  tone,
}: {
  keyName: string | null;
  display: string;
  tone: 'num' | 'bool' | 'muted';
}): React.ReactElement {
  const colorVar =
    tone === 'num' ? '--accent' : tone === 'bool' ? '--ok' : '--fg-subtle';
  return (
    <div style={{ paddingLeft: 12 }}>
      {keyName !== null ? (
        <>
          <span className="text-[color:var(--fg-muted)]">{keyName}</span>
          <span className="text-[color:var(--fg-subtle)]">: </span>
        </>
      ) : null}
      <span style={{ color: `var(${colorVar})` }}>{display}</span>
    </div>
  );
}

const STRING_TRUNCATE_AT = 200;

function StringLine({
  keyName,
  value,
}: {
  keyName: string | null;
  value: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const tooLong = value.length > STRING_TRUNCATE_AT;
  const displayed = tooLong && !expanded ? value.slice(0, STRING_TRUNCATE_AT) : value;
  return (
    <div style={{ paddingLeft: 12 }} className="break-words">
      {keyName !== null ? (
        <>
          <span className="text-[color:var(--fg-muted)]">{keyName}</span>
          <span className="text-[color:var(--fg-subtle)]">: </span>
        </>
      ) : null}
      <span className="text-[color:var(--ok)]">&quot;{displayed}</span>
      {tooLong && !expanded ? (
        <>
          <span className="text-[color:var(--ok)]">…</span>
          <button
            type="button"
            onClick={(): void => setExpanded(true)}
            className="ml-2 text-[10px] uppercase tracking-[0.16em] text-[color:var(--accent)] underline-offset-2 hover:underline"
          >
            mehr ({value.length - STRING_TRUNCATE_AT} Zeichen)
          </button>
        </>
      ) : null}
      {tooLong && expanded ? (
        <>
          <span className="text-[color:var(--ok)]">&quot;</span>
          <button
            type="button"
            onClick={(): void => setExpanded(false)}
            className="ml-2 text-[10px] uppercase tracking-[0.16em] text-[color:var(--accent)] underline-offset-2 hover:underline"
          >
            weniger
          </button>
        </>
      ) : !tooLong ? (
        <span className="text-[color:var(--ok)]">&quot;</span>
      ) : null}
    </div>
  );
}
