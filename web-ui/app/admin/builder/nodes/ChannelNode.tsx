'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { ChannelNodeData } from './types';

export function ChannelNodeView({
  data,
  selected,
}: NodeProps & { data: ChannelNodeData }): React.ReactElement {
  const { channel, labels } = data;
  return (
    <NodeShell
      kind="channel"
      title={channel.channelType}
      subtitle={channel.channelKey}
      badge={labels['channel']}
      selected={selected}
      hasSource
    />
  );
}
