'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { SubAgentNodeData } from './types';

export function SubAgentNodeView({
  data,
  selected,
}: NodeProps & { data: SubAgentNodeData }): React.ReactElement {
  const { subAgent, labels } = data;
  return (
    <NodeShell
      kind="subagent"
      title={subAgent.name}
      subtitle={subAgent.model}
      badge={labels['subAgent']}
      selected={selected}
      hasTarget
      hasSource
    />
  );
}
