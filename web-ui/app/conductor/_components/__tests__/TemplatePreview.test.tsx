import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConductorTemplate } from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { buildTemplatePreviewFlow, TemplatePreview } from '../TemplatePreview';

// jsdom cannot drive @xyflow/react's measured canvas — the mock renders the node
// DATA it receives plus the interactivity props as attributes, so the tests pin
// the render CONTRACT (what the flow is asked to draw, and that it is locked
// read-only), not pixels.
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: Array<{ id: string; data: { stepId: string; kind: string; primary: string; isEntry: boolean } }>;
    edges: Array<{ id: string; source: string; target: string }>;
    fitView?: boolean;
    nodesDraggable?: boolean;
    nodesConnectable?: boolean;
    elementsSelectable?: boolean;
  }) => (
    <div
      data-testid="preview-flow"
      data-fit-view={String(props.fitView)}
      data-nodes-draggable={String(props.nodesDraggable)}
      data-nodes-connectable={String(props.nodesConnectable)}
      data-elements-selectable={String(props.elementsSelectable)}
      data-edge-count={props.edges.length}
    >
      {props.nodes.map((n) => (
        <div key={n.id} data-testid={`preview-node-${n.id}`}>
          {n.data.kind}:{n.data.primary}
          {n.data.isEntry ? ':entry' : ''}
        </div>
      ))}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}));

/** A manifest graph mixing slot placeholders and concrete refs, one authored position. */
const template: ConductorTemplate = {
  id: 'expense-approval',
  name: 'Expense approval',
  description: 'Route an expense to the right approver.',
  useCase: 'approval',
  defaultSlug: 'expense-approval',
  graph: {
    entryStepId: 'classify',
    steps: [
      { id: 'classify', kind: 'agent', agentId: 'slot:agent:classifier', prompt: 'Classify.', position: { x: 10, y: 20 } },
      { id: 'notify', kind: 'action', actionId: 'sendMail' },
      {
        id: 'signoff',
        kind: 'human',
        human: { principal: { kind: 'role', ref: 'slot:role:approver' }, channel: 'slot:channel:notify', message: 'Approve?' },
      },
    ],
    transitions: [
      { id: 't1', source: 'classify', target: 'notify' },
      { id: 't2', source: 'notify', target: 'signoff' },
    ] as unknown[],
    triggers: [{ id: 'tr', kind: 'event', eventId: 'slot:event:expense-submitted' }],
  },
  slots: {
    agents: [{ key: 'classifier', label: { en: 'Expense classifier', de: 'Spesen-Klassifizierer' } }],
    roles: [{ key: 'approver', label: 'Approver' }],
    channels: [{ key: 'notify', label: 'Notification channel' }],
    events: [{ key: 'expense-submitted', label: 'Expense submitted' }],
  },
};

describe('buildTemplatePreviewFlow', () => {
  it('labels slot placeholders with their declared slot labels and passes concrete refs through', () => {
    const { nodes, edges } = buildTemplatePreviewFlow(template, 'en');

    expect(nodes.map((n) => n.data.primary)).toEqual(['Expense classifier', 'sendMail', 'Approver']);
    expect(nodes.map((n) => n.data.kind)).toEqual(['agent', 'action', 'human']);
    // Only the entry step carries the entry flag.
    expect(nodes.map((n) => n.data.isEntry)).toEqual([true, false, false]);
    expect(edges).toEqual([
      { id: 't1', source: 'classify', target: 'notify' },
      { id: 't2', source: 'notify', target: 'signoff' },
    ]);
  });

  it('resolves slot labels for the active locale', () => {
    const { nodes } = buildTemplatePreviewFlow(template, 'de');
    expect(nodes[0]?.data.primary).toBe('Spesen-Klassifizierer');
  });

  it('keeps authored positions and grid-falls-back for steps without one', () => {
    const { nodes } = buildTemplatePreviewFlow(template, 'en');
    expect(nodes[0]?.position).toEqual({ x: 10, y: 20 });
    // Designer hydration grid: 4 per row, 200x130 pitch starting at (80, 80).
    expect(nodes[1]?.position).toEqual({ x: 280, y: 80 });
    expect(nodes[2]?.position).toEqual({ x: 480, y: 80 });
  });

  it('falls back to the raw key for an UNDECLARED placeholder instead of leaking the token', () => {
    const undeclared: ConductorTemplate = {
      ...template,
      graph: {
        ...template.graph,
        steps: [{ id: 'classify', kind: 'agent', agentId: 'slot:agent:ghost' }],
        transitions: [],
      },
      slots: {},
    };
    const { nodes } = buildTemplatePreviewFlow(undeclared, 'en');
    expect(nodes[0]?.data.primary).toBe('ghost');
  });
});

describe('<TemplatePreview />', () => {
  it('renders every step read-only, fit to the container', () => {
    renderWithIntl(<TemplatePreview template={template} />);

    expect(screen.getByTestId('template-preview')).toBeInTheDocument();
    const flow = screen.getByTestId('preview-flow');
    expect(flow).toHaveAttribute('data-fit-view', 'true');
    expect(flow).toHaveAttribute('data-nodes-draggable', 'false');
    expect(flow).toHaveAttribute('data-nodes-connectable', 'false');
    expect(flow).toHaveAttribute('data-elements-selectable', 'false');
    expect(flow).toHaveAttribute('data-edge-count', '2');

    expect(screen.getByTestId('preview-node-classify')).toHaveTextContent('agent:Expense classifier:entry');
    expect(screen.getByTestId('preview-node-notify')).toHaveTextContent('action:sendMail');
    expect(screen.getByTestId('preview-node-signoff')).toHaveTextContent('human:Approver');
  });

  it('resolves slot labels for the active locale in the rendered nodes', () => {
    renderWithIntl(<TemplatePreview template={template} />, { locale: 'de' });
    expect(screen.getByTestId('preview-node-classify')).toHaveTextContent('agent:Spesen-Klassifizierer:entry');
  });
});
