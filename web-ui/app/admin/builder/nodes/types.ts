import type { Node } from '@xyflow/react';
import type {
  AgentNode,
  CanvasNodeKind,
  ChannelNode,
  McpServerNode,
  PluginNode,
  ScheduleNode,
  SkillNode,
  SubAgentNode,
  ToolGrantNode,
} from '../../../_lib/agentBuilder';

/**
 * Per-node data carried on the ReactFlow node. Every node stamps its
 * `kind` so `isValidConnection` can look the source/target pair up against
 * the edge-semantics table without re-deriving it from the DOM.
 */
export interface BaseNodeData extends Record<string, unknown> {
  kind: CanvasNodeKind;
  /** i18n labels resolved once in the canvas and threaded into node UIs. */
  labels: Record<string, string>;
}

export interface ChannelNodeData extends BaseNodeData {
  kind: 'channel';
  channel: ChannelNode;
}
export interface AgentNodeData extends BaseNodeData {
  kind: 'agent';
  agent: AgentNode;
}
export interface SubAgentNodeData extends BaseNodeData {
  kind: 'subagent';
  subAgent: SubAgentNode;
}
export interface SkillNodeData extends BaseNodeData {
  kind: 'skill';
  skill: SkillNode;
}
export interface ToolNodeData extends BaseNodeData {
  kind: 'tool';
  toolRef: string;
  grant: ToolGrantNode | null;
}
export interface McpNodeData extends BaseNodeData {
  kind: 'mcp';
  server: McpServerNode;
}
export interface ScheduleNodeData extends BaseNodeData {
  kind: 'schedule';
  schedule: ScheduleNode;
}
export interface PluginNodeData extends BaseNodeData {
  kind: 'plugin';
  plugin: PluginNode;
}

export type BuilderNodeData =
  | ChannelNodeData
  | AgentNodeData
  | SubAgentNodeData
  | SkillNodeData
  | ToolNodeData
  | McpNodeData
  | ScheduleNodeData
  | PluginNodeData;

export type BuilderNode = Node<BuilderNodeData>;
