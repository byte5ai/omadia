import type { Edge } from '@xyflow/react';
import type { AgentGraph, CanvasNodeKind } from '../../_lib/agentBuilder';
import type { BuilderNode } from './nodes/types';

/**
 * Deterministic node-id helpers. A canvas node id encodes its kind so the
 * connection handler can recover the node-kind pair purely from the id when
 * the node `data` is momentarily stale during an optimistic add.
 */
export const nodeId = {
  channel: (c: { channelType: string; channelKey: string }): string =>
    `channel:${c.channelType}:${c.channelKey}`,
  agent: (id: string): string => `agent:${id}`,
  subagent: (id: string): string => `subagent:${id}`,
  skill: (id: string): string => `skill:${id}`,
  tool: (ref: string): string => `tool:${ref}`,
  mcp: (id: string): string => `mcp:${id}`,
  schedule: (id: string): string => `schedule:${id}`,
  plugin: (id: string): string => `plugin:${id}`,
};

export function kindOfNodeId(id: string): CanvasNodeKind | null {
  const prefix = id.split(':', 1)[0];
  switch (prefix) {
    case 'channel':
      return 'channel';
    case 'agent':
      return 'agent';
    case 'subagent':
      return 'subagent';
    case 'skill':
      return 'skill';
    case 'tool':
      return 'tool';
    case 'mcp':
      return 'mcp';
    case 'schedule':
      return 'schedule';
    case 'plugin':
      return 'plugin';
    default:
      return null;
  }
}

/** Auto-layout fallback when a node carries no persisted position. */
function gridPos(col: number, row: number): { x: number; y: number } {
  return { x: col * 300 + 40, y: row * 130 + 40 };
}

export function graphToFlow(
  graph: AgentGraph,
  labels: Record<string, string>,
): { nodes: BuilderNode[]; edges: Edge[] } {
  const nodes: BuilderNode[] = [];

  graph.channels.forEach((channel, i) => {
    nodes.push({
      id: nodeId.channel(channel),
      type: 'channel',
      position: channel.position ?? gridPos(0, i),
      data: { kind: 'channel', labels, channel },
    });
  });

  nodes.push({
    id: nodeId.agent(graph.agent.id),
    type: 'agent',
    position: graph.agent.position ?? gridPos(1, 0),
    deletable: false,
    data: { kind: 'agent', labels, agent: graph.agent },
  });

  (graph.plugins ?? []).forEach((plugin, i) => {
    nodes.push({
      id: nodeId.plugin(plugin.id),
      type: 'plugin',
      position: gridPos(1, i + 1),
      deletable: false,
      connectable: false,
      data: { kind: 'plugin', labels, plugin },
    });
  });

  graph.subAgents.forEach((subAgent, i) => {
    nodes.push({
      id: nodeId.subagent(subAgent.id),
      type: 'subagent',
      position: subAgent.position ?? gridPos(2, i),
      data: { kind: 'subagent', labels, subAgent },
    });
  });

  graph.skills.forEach((skill, i) => {
    nodes.push({
      id: nodeId.skill(skill.id),
      type: 'skill',
      position: gridPos(3, i),
      data: { kind: 'skill', labels, skill },
    });
  });

  const grantByTool = new Map(graph.tools.map((g) => [g.toolRef, g]));
  const toolRefs = new Set(graph.tools.map((g) => g.toolRef));
  Array.from(toolRefs).forEach((ref, i) => {
    nodes.push({
      id: nodeId.tool(ref),
      type: 'tool',
      position: gridPos(3, graph.skills.length + i),
      data: { kind: 'tool', labels, toolRef: ref, grant: grantByTool.get(ref) ?? null },
    });
  });

  graph.mcpServers.forEach((server, i) => {
    nodes.push({
      id: nodeId.mcp(server.id),
      type: 'mcp',
      position: gridPos(4, i),
      data: { kind: 'mcp', labels, server },
    });
  });

  graph.schedules.forEach((schedule, i) => {
    nodes.push({
      id: nodeId.schedule(schedule.id),
      type: 'schedule',
      position: gridPos(0, graph.channels.length + i),
      data: { kind: 'schedule', labels, schedule },
    });
  });

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: { kind: e.kind },
    animated: e.kind === 'schedule',
  }));

  return { nodes, edges };
}
