'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { AgentNodeData } from './types';

export function AgentNodeView({
  data,
  selected,
}: NodeProps & { data: AgentNodeData }): React.ReactElement {
  const { agent, labels } = data;
  const routing = agent.modelRouting;
  return (
    <NodeShell
      kind="agent"
      title={agent.name}
      subtitle={agent.description}
      badge={labels['agent']}
      selected={selected}
      hasTarget
      hasSource
    >
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Pill text={agent.privacyProfile} />
        <Pill text={agent.status} />
        {routing ? <Pill text={`${routing.mode}: ${routing.main}`} /> : null}
      </div>
    </NodeShell>
  );
}

function Pill({ text }: { text: string }): React.ReactElement {
  return (
    <span className="rounded bg-[color:var(--border)]/40 px-1.5 py-0.5 text-[9px] text-[color:var(--fg-muted)]">
      {text}
    </span>
  );
}
