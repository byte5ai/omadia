'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { ScheduleNodeData } from './types';

export function ScheduleNodeView({
  data,
  selected,
}: NodeProps & { data: ScheduleNodeData }): React.ReactElement {
  const { schedule, labels } = data;
  return (
    <NodeShell
      kind="schedule"
      title={schedule.cron}
      subtitle={schedule.timezone}
      badge={labels['schedule']}
      selected={selected}
      hasSource
    />
  );
}
