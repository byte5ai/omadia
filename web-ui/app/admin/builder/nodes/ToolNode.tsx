'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { ToolNodeData } from './types';

export function ToolNodeView({
  data,
  selected,
}: NodeProps & { data: ToolNodeData }): React.ReactElement {
  const { toolRef, labels, system } = data;
  return (
    <NodeShell
      kind="tool"
      title={toolRef}
      badge={labels['tool']}
      subtitle={system ? labels['nativeBaseline'] : null}
      selected={selected}
      hasTarget
    />
  );
}
