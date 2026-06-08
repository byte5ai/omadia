'use client';

import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import type { SkillNodeData } from './types';

export function SkillNodeView({
  data,
  selected,
}: NodeProps & { data: SkillNodeData }): React.ReactElement {
  const { skill, labels } = data;
  return (
    <NodeShell
      kind="skill"
      title={skill.name}
      subtitle={skill.description}
      badge={labels['skill']}
      selected={selected}
      hasTarget
    />
  );
}
