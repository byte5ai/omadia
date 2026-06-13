'use client';

import '@xyflow/react/dist/style.css';

import {
  Background,
  Controls,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createGraphEdge,
  createSubAgent,
  createSchedule,
  createSkill,
  createMcpServer,
  deleteGraphEdge,
  patchPositions,
  resolveEdgeKind,
  type CanvasPosition,
  type EdgeKind,
} from '../../_lib/agentBuilder';
import { AgentNodeView } from './nodes/AgentNode';
import { ChannelNodeView } from './nodes/ChannelNode';
import { McpServerNodeView } from './nodes/McpServerNode';
import { ScheduleNodeView } from './nodes/ScheduleNode';
import { SkillNodeView } from './nodes/SkillNode';
import { SubAgentNodeView } from './nodes/SubAgentNode';
import { ToolNodeView } from './nodes/ToolNode';
import type { BuilderNode, BuilderNodeData } from './nodes/types';
import { graphToFlow, kindOfNodeId, nodeId } from './graphMapping';
import { InspectorPanel } from './panels/InspectorPanel';
import { DND_MIME, PalettePanel } from './panels/PalettePanel';
import { TOOL_DND_MIME, ToolboxPanel, type ToolDragPayload } from './panels/ToolboxPanel';
import { useAgentGraph } from './useAgentGraph';

const nodeTypes: NodeTypes = {
  channel: ChannelNodeView as NodeTypes[string],
  agent: AgentNodeView as NodeTypes[string],
  subagent: SubAgentNodeView as NodeTypes[string],
  skill: SkillNodeView as NodeTypes[string],
  tool: ToolNodeView as NodeTypes[string],
  mcp: McpServerNodeView as NodeTypes[string],
  schedule: ScheduleNodeView as NodeTypes[string],
};

export interface BuilderCanvasProps {
  slug: string;
}

export default function BuilderCanvas(props: BuilderCanvasProps): React.ReactElement {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ slug }: BuilderCanvasProps): React.ReactElement {
  const t = useTranslations('admin.builder');
  const { state, actionError, clearActionError, reload, mutate } = useAgentGraph(slug);
  const { screenToFlowPosition } = useReactFlow();

  const labels = useMemo(
    () => ({
      channel: t('nodes.channel'),
      agent: t('nodes.agent'),
      subAgent: t('nodes.subagent'),
      skill: t('nodes.skill'),
      tool: t('nodes.tool'),
      mcp: t('nodes.mcp'),
      schedule: t('nodes.schedule'),
      tools: t('nodes.tools'),
    }),
    [t],
  );

  const [nodes, setNodes] = useState<BuilderNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<BuilderNodeData | null>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Re-derive the flow graph whenever the authoritative state changes.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const flow = graphToFlow(state.graph, labels);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [state, labels]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns) as BuilderNode[]);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
  }, []);

  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    const s = kindOfNodeId(c.source ?? '');
    const tgt = kindOfNodeId(c.target ?? '');
    if (!s || !tgt) return false;
    return resolveEdgeKind(s, tgt) !== null;
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      const s = kindOfNodeId(c.source);
      const tgt = kindOfNodeId(c.target);
      if (!s || !tgt) return;
      const kind = resolveEdgeKind(s, tgt);
      if (!kind || !c.source || !c.target) return;
      const tempId = `tmp-${String(Date.now())}`;
      const source = c.source;
      const target = c.target;
      setEdges((es) => [...es, { id: tempId, source, target, data: { kind } }]);
      void mutate(
        (g) => g,
        async () => {
          try {
            const res = await createGraphEdge(slug, { kind, source, target });
            setEdges((es) =>
              es.map((e) => (e.id === tempId ? { ...e, id: res.edge.id } : e)),
            );
          } catch (err) {
            setEdges((es) => es.filter((e) => e.id !== tempId));
            throw err;
          }
        },
      );
    },
    [slug, mutate],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      void mutate(
        (g) => g,
        async () => {
          for (const e of deleted) {
            const kind = (e.data as { kind?: EdgeKind } | undefined)?.kind;
            if (!kind || e.id.startsWith('tmp-')) continue;
            await deleteGraphEdge(slug, e.id, kind);
          }
        },
      );
    },
    [slug, mutate],
  );

  // Debounced persistence of node positions after a drag settles.
  const onNodeDragStop = useCallback(() => {
    if (dragTimer.current) clearTimeout(dragTimer.current);
    dragTimer.current = setTimeout(() => {
      void persistPositions(slug, nodes);
    }, 600);
  }, [slug, nodes]);

  useEffect(
    () => () => {
      if (dragTimer.current) clearTimeout(dragTimer.current);
    },
    [],
  );

  const onSelectionChange = useCallback(
    (params: { nodes: BuilderNode[] }) => {
      const first = params.nodes.length > 0 ? params.nodes[0] : undefined;
      setSelected(first ? first.data : null);
    },
    [],
  );

  const handleToolDrop = useCallback(
    (raw: string, pos: CanvasPosition): void => {
      const payload = JSON.parse(raw) as ToolDragPayload;
      // Find the agent/sub-agent node under the drop point to grant against.
      const targetNode = nodeUnderPoint(nodes, pos);
      if (
        !targetNode ||
        (targetNode.data.kind !== 'agent' && targetNode.data.kind !== 'subagent')
      ) {
        clearActionError();
        return;
      }
      const toolNodeId = nodeId.tool(payload.toolRef);
      void mutate(
        (g) => g,
        async () => {
          await createGraphEdge(slug, {
            kind: 'tool_grant',
            source: targetNode.id,
            target: toolNodeId,
            config: {
              toolKind: payload.toolKind,
              toolRef: payload.toolRef,
              mcpServerId: payload.mcpServerId,
            },
          });
          await reload();
        },
      );
    },
    [slug, nodes, mutate, reload, clearActionError],
  );

  const handlePaletteDrop = useCallback(
    (kind: string, pos: CanvasPosition): void => {
      void mutate(
        (g) => g,
        async () => {
          if (kind === 'subagent') {
            await createSubAgent(slug, {
              name: t('defaults.subAgentName'),
              position: pos,
            });
          } else if (kind === 'skill') {
            await createSkill({
              slug: `skill-${String(Date.now())}`,
              name: t('defaults.skillName'),
              body: '',
            });
          } else if (kind === 'mcp') {
            await createMcpServer({ name: t('defaults.mcpName'), transport: 'http' });
          } else if (kind === 'schedule') {
            await createSchedule(slug, { cron: '0 9 * * *', timezone: 'UTC' });
          } else {
            // channel — created via binding edge once wired; nothing to POST yet.
            return;
          }
          await reload();
        },
      );
    },
    [slug, mutate, reload, t],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const toolRaw = e.dataTransfer.getData(TOOL_DND_MIME);
      if (toolRaw) {
        handleToolDrop(toolRaw, pos);
        return;
      }
      const nodeKind = e.dataTransfer.getData(DND_MIME);
      if (nodeKind) handlePaletteDrop(nodeKind, pos);
    },
    [screenToFlowPosition, handleToolDrop, handlePaletteDrop],
  );

  if (state.kind === 'loading') {
    return <Centered text={t('loading')} />;
  }
  if (state.kind === 'error') {
    return <Centered text={`${t('loadError')}: ${state.message}`} tone="error" />;
  }

  return (
    <div className="flex h-full w-full">
      <PalettePanel />
      <div
        ref={wrapRef}
        className="relative h-full flex-1"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={onDrop}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          isValidConnection={isValidConnection}
          fitView
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {actionError && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/10 px-4 py-2 text-sm text-[color:var(--danger)]">
            {actionError}
          </div>
        )}
      </div>
      {selected && (
        <InspectorPanel
          slug={slug}
          data={selected}
          onClose={() => setSelected(null)}
          onSaved={() => void reload()}
        />
      )}
      {state.kind === 'ready' && (
        <ToolboxPanel mcpServers={state.graph.mcpServers} />
      )}
    </div>
  );
}

function nodeUnderPoint(nodes: BuilderNode[], pos: CanvasPosition): BuilderNode | null {
  // Reverse so topmost (later-rendered) node wins on overlap.
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i];
    if (!n) continue;
    const w = n.measured?.width ?? 220;
    const h = n.measured?.height ?? 80;
    if (
      pos.x >= n.position.x &&
      pos.x <= n.position.x + w &&
      pos.y >= n.position.y &&
      pos.y <= n.position.y + h
    ) {
      return n;
    }
  }
  return null;
}

async function persistPositions(slug: string, nodes: BuilderNode[]): Promise<void> {
  const subAgents: Array<{ id: string; position: CanvasPosition }> = [];
  const channels: Array<{
    channelType: string;
    channelKey: string;
    position: CanvasPosition;
  }> = [];
  let agent: CanvasPosition | undefined;

  for (const n of nodes) {
    const data = n.data;
    if (data.kind === 'agent') {
      agent = n.position;
    } else if (data.kind === 'subagent') {
      subAgents.push({ id: data.subAgent.id, position: n.position });
    } else if (data.kind === 'channel') {
      channels.push({
        channelType: data.channel.channelType,
        channelKey: data.channel.channelKey,
        position: n.position,
      });
    }
  }
  try {
    await patchPositions(slug, {
      ...(agent ? { agent } : {}),
      ...(subAgents.length ? { subAgents } : {}),
      ...(channels.length ? { channels } : {}),
    });
  } catch {
    // Position drift is non-critical; a reload will reconcile.
  }
}

function Centered({
  text,
  tone,
}: {
  text: string;
  tone?: 'error';
}): React.ReactElement {
  return (
    <div
      className={`flex h-full w-full items-center justify-center text-sm ${tone === 'error' ? 'text-[color:var(--danger)]' : 'text-[color:var(--fg-muted)]'}`}
    >
      {text}
    </div>
  );
}
