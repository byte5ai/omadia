import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getConductorActions,
  getConductorAgents,
  getConductorEventCatalog,
  getConductorRoles,
  publishConductorWorkflow,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { ConductorCanvas, type CanvasGraphRequest } from '../ConductorCanvas';

// jsdom cannot drive @xyflow/react's measured canvas — stub the flow surface with inert
// elements. What's under test here is the plain-React toolbar/save logic around it,
// specifically that Save publishes with the `enable` choice carried by a template
// handoff (#429) instead of a hardcoded true.
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="flow-canvas" />,
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  addEdge: (_connection: unknown, edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
  applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
}));

// Partial mock: only the network layer is stubbed — types stay real.
vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    getConductorActions: vi.fn(),
    getConductorAgents: vi.fn(),
    getConductorEventCatalog: vi.fn(),
    getConductorRoles: vi.fn(),
    getConductorRun: vi.fn(),
    getConductorWorkflowGraph: vi.fn(),
    previewConductorWorkflow: vi.fn(),
    publishConductorWorkflow: vi.fn(),
    startConductorRun: vi.fn(),
  };
});

/** A resolved weekly-report-style template instance: one agent step, cron trigger. */
const cronGraph = {
  entryStepId: 'compile',
  steps: [{ id: 'compile', kind: 'agent', agentId: 'report-bot', prompt: 'Compile the report.' }],
  transitions: [],
  triggers: [{ id: 't1', kind: 'cron', cron: '0 9 * * 1' }],
};

function renderCanvas(loadGraphRequest: CanvasGraphRequest): void {
  renderWithIntl(<ConductorCanvas workflows={[]} onSaved={vi.fn()} loadGraphRequest={loadGraphRequest} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getConductorEventCatalog).mockResolvedValue({ events: [], byPlugin: {} });
  vi.mocked(getConductorRoles).mockResolvedValue({ roles: [] });
  vi.mocked(getConductorAgents).mockResolvedValue({ agents: [] });
  vi.mocked(getConductorActions).mockResolvedValue({ actions: [] });
  vi.mocked(publishConductorWorkflow).mockResolvedValue({
    workflow: { slug: 'weekly-report' } as never,
    version: { id: 'v1', version: 1 },
  });
});

describe('<ConductorCanvas /> template handoff (#429)', () => {
  it('publishes with enable: false when the graph request carries the default-off toggle', async () => {
    const user = userEvent.setup();
    renderCanvas({ graph: cronGraph, nonce: 1, slug: 'weekly-report', name: 'Weekly report', enable: false });

    await user.click(await screen.findByRole('button', { name: 'Save & publish' }));

    await waitFor(() => {
      // The regression this pins down: Save used to hardcode enable: true, silently
      // starting a cron template's schedule the operator chose to keep off.
      expect(publishConductorWorkflow).toHaveBeenCalledWith({
        slug: 'weekly-report',
        name: 'Weekly report',
        graph: expect.objectContaining({ entryStepId: 'compile' }),
        enable: false,
      });
    });
  });

  it('keeps the historical enable-on-save behaviour for requests without an enable choice', async () => {
    const user = userEvent.setup();
    // The chat-draft path (US7) omits enable — hand-built drafts still publish enabled.
    renderCanvas({ graph: cronGraph, nonce: 1, slug: 'weekly-report', name: 'Weekly report' });

    await user.click(await screen.findByRole('button', { name: 'Save & publish' }));

    await waitFor(() => {
      expect(publishConductorWorkflow).toHaveBeenCalledWith(expect.objectContaining({ enable: true }));
    });
  });
});
