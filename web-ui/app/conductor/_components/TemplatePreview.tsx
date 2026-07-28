'use client';

import { useMemo } from 'react';
import { useLocale } from 'next-intl';
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { resolveConductorText, type ConductorTemplate } from '@/app/_lib/api';

import { KIND_BADGE_FG, KIND_COLOR } from './stepKindColors';

/**
 * Read-only template graph preview (#478 F3). Renders the MANIFEST graph — slot
 * placeholders and all — into a small, non-interactive designer canvas so the
 * operator sees the workflow's shape before mapping a single slot. No stored
 * thumbnails: the preview is always live from the manifest. The plan drafted
 * this on "the existing Cytoscape stack", but the designer actually runs on
 * @xyflow/react — same contract (fit-to-container, read-only, canvas styling
 * reused), adapted to the real stack.
 *
 * Slot placeholders (`slot:<kind>:<key>`) in the five ref fields render as
 * their DECLARED SLOT LABELS (locale-resolved), not as raw tokens: the preview
 * answers "what will I be mapping where", mirroring the instantiate form.
 */

interface PreviewNodeData extends Record<string, unknown> {
  stepId: string;
  kind: string;
  /** the step's primary ref, slot placeholders already resolved to labels. */
  primary: string;
  isEntry: boolean;
}

type PreviewNode = Node<PreviewNodeData>;

/** kind (plural, as declared in TemplateSlots) → placeholder token (singular);
 *  mirrors conductor-core's SLOT_TOKEN. */
const SLOT_TOKEN: Record<'agents' | 'actions' | 'roles' | 'events' | 'channels', string> = {
  agents: 'agent',
  actions: 'action',
  roles: 'role',
  events: 'event',
  channels: 'channel',
};

/** A `slot:<token>:<key>` ref → the declared slot's locale-resolved label
 *  (fallback: the raw key); concrete refs pass through unchanged. */
function slotAwareRef(
  template: ConductorTemplate,
  kind: keyof typeof SLOT_TOKEN,
  value: string,
  locale: string,
): string {
  const prefix = `slot:${SLOT_TOKEN[kind]}:`;
  if (!value.startsWith(prefix)) return value;
  const key = value.slice(prefix.length);
  const slot = (template.slots[kind] ?? []).find((s) => s.key === key);
  return slot ? resolveConductorText(slot.label, locale) : key;
}

/**
 * Manifest graph → React Flow nodes/edges. Pure — exported for the render-
 * contract tests. Steps without an authored `position` fall back to the same
 * 4-per-row grid the designer uses when it hydrates a graph.
 */
export function buildTemplatePreviewFlow(
  template: ConductorTemplate,
  locale: string,
): { nodes: PreviewNode[]; edges: Edge[] } {
  const graph = template.graph;
  const steps = Array.isArray(graph.steps) ? (graph.steps as Array<Record<string, unknown>>) : [];
  const transitions = Array.isArray(graph.transitions)
    ? (graph.transitions as Array<Record<string, unknown>>)
    : [];

  const nodes: PreviewNode[] = steps.map((step, i) => {
    const kind = String(step.kind ?? '');
    const human = (step.human ?? {}) as Record<string, unknown>;
    const principal = (human.principal ?? {}) as Record<string, unknown>;
    const primary =
      kind === 'agent'
        ? slotAwareRef(template, 'agents', String(step.agentId ?? ''), locale)
        : kind === 'action'
          ? slotAwareRef(template, 'actions', String(step.actionId ?? ''), locale)
          : slotAwareRef(template, 'roles', String(principal.ref ?? ''), locale);
    const authored = step.position as { x?: unknown; y?: unknown } | undefined;
    const position =
      typeof authored?.x === 'number' && typeof authored.y === 'number'
        ? { x: authored.x, y: authored.y }
        : { x: 80 + (i % 4) * 200, y: 80 + Math.floor(i / 4) * 130 };
    return {
      id: String(step.id),
      type: 'previewStep',
      position,
      data: {
        stepId: String(step.id),
        kind,
        primary: primary || '—',
        isEntry: step.id === graph.entryStepId,
      },
    };
  });

  const edges: Edge[] = transitions.map((tr) => ({
    id: String(tr.id),
    source: String(tr.source),
    target: String(tr.target),
  }));

  return { nodes, edges };
}

/** Miniature of the designer's StepNodeView: kind badge, entry badge, step id,
 *  primary ref — minus selection/handles interactivity. */
function PreviewStepNode({ data }: NodeProps<PreviewNode>): React.JSX.Element {
  return (
    <div
      style={{ borderColor: KIND_COLOR[data.kind] ?? 'var(--border)' }}
      className="min-w-[130px] rounded-md border-2 bg-[color:var(--card)] px-3 py-2 text-[color:var(--fg-strong)] shadow"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={{ background: KIND_COLOR[data.kind] ?? 'var(--border)', color: KIND_BADGE_FG }}
        >
          {data.kind}
        </span>
        {data.isEntry && (
          <span className="rounded bg-[color:var(--fg-strong)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--card)]">
            entry
          </span>
        )}
      </div>
      <div className="mt-1 font-mono text-[12px] font-medium">{data.stepId}</div>
      <div className="font-mono text-[11px] text-[color:var(--fg-muted)]">{data.primary}</div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const previewNodeTypes: NodeTypes = { previewStep: PreviewStepNode };

export function TemplatePreview({ template }: { template: ConductorTemplate }): React.JSX.Element {
  const locale = useLocale();
  const { nodes, edges } = useMemo(() => buildTemplatePreviewFlow(template, locale), [template, locale]);
  return (
    <div className="h-[260px] rounded-lg border border-[color:var(--border)]" data-testid="template-preview">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={previewNodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
        >
          <Background />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
