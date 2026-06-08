'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { PluginNodeData } from './types';

/**
 * Read-only node mirroring an enabled plugin on the agent — the current-system
 * representation. Not deletable/connectable (managed via plugin install, not
 * the canvas); it connects into the agent so the operator sees the real
 * capability surface at a glance.
 */
export function PluginNodeView({
  data,
  selected,
}: NodeProps & { data: PluginNodeData }): React.ReactElement {
  const { plugin, labels } = data;
  return (
    <NodeShell
      kind="plugin"
      title={plugin.id}
      badge={labels['plugin']}
      selected={selected}
      hasSource
    />
  );
}
