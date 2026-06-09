'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { McpNodeData } from './types';

export function McpServerNodeView({
  data,
  selected,
}: NodeProps & { data: McpNodeData }): React.ReactElement {
  const { server, labels } = data;
  const toolCount = server.discoveredTools.length;
  return (
    <NodeShell
      kind="mcp"
      title={server.name}
      subtitle={server.endpoint ?? server.transport}
      badge={labels['mcp']}
      selected={selected}
      hasTarget
    >
      <div className="mt-1.5 text-[10px] text-[color:var(--fg-muted)]">
        {toolCount} {labels['tools']}
      </div>
    </NodeShell>
  );
}
