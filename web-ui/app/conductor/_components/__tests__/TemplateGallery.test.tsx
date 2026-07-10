import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ConductorTemplate } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { TemplateGallery } from '../TemplateGallery';

const approvalTemplate: ConductorTemplate = {
  id: 'expense-approval',
  name: 'Expense approval',
  description: 'Route an expense to the right approver, with escalation above a threshold.',
  useCase: 'approval',
  defaultSlug: 'expense-approval',
  graph: {
    entryStepId: 'submit',
    steps: [],
    transitions: [],
    triggers: [{ id: 't1', kind: 'event', eventId: 'slot:event:expense-submitted' }],
  },
  slots: {
    roles: [
      { key: 'approver', label: 'Approver' },
      { key: 'finance', label: 'Finance escalation' },
    ],
    agents: [
      { key: 'classifier', label: 'Expense classifier' },
      { key: 'notifier', label: 'Notifier' },
    ],
    channels: [{ key: 'notify', label: 'Notification channel' }],
  },
};

const reportTemplate: ConductorTemplate = {
  id: 'weekly-report',
  name: 'Weekly report',
  description: 'Compile and deliver a status report every week.',
  useCase: 'reporting',
  defaultSlug: 'weekly-report',
  graph: {
    entryStepId: 'compile',
    steps: [],
    transitions: [],
    triggers: [{ id: 't1', kind: 'cron', cron: '0 9 * * 1' }],
  },
  slots: {
    agents: [{ key: 'reporter', label: 'Report writer' }],
  },
};

describe('<TemplateGallery />', () => {
  it('renders one card per template with name, description and use-case tag', () => {
    renderWithIntl(
      <TemplateGallery templates={[approvalTemplate, reportTemplate]} onUseTemplate={vi.fn()} />,
    );

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Expense approval')).toBeInTheDocument();
    expect(screen.getByText(approvalTemplate.description)).toBeInTheDocument();
    expect(screen.getByText('approval')).toBeInTheDocument();
    expect(screen.getByText('Weekly report')).toBeInTheDocument();
    expect(screen.getByText(reportTemplate.description)).toBeInTheDocument();
    expect(screen.getByText('reporting')).toBeInTheDocument();
  });

  it('derives the slot-mapping summary from mixed slot kinds with pluralization', () => {
    renderWithIntl(
      <TemplateGallery templates={[approvalTemplate, reportTemplate]} onUseTemplate={vi.fn()} />,
    );

    // Mixed kinds, declared order roles → agents → … → channels; absent kinds omitted.
    expect(screen.getByText('You will map: 2 roles · 2 agents · 1 channel')).toBeInTheDocument();
    // Singular form for a one-slot template.
    expect(screen.getByText('You will map: 1 agent')).toBeInTheDocument();
  });

  it('shows the schedule badge only for templates with a cron trigger', () => {
    renderWithIntl(
      <TemplateGallery templates={[approvalTemplate, reportTemplate]} onUseTemplate={vi.fn()} />,
    );

    const badges = screen.getAllByText('Runs on a schedule');
    expect(badges).toHaveLength(1);
    const [approvalCard, reportCard] = screen.getAllByRole('article');
    if (!approvalCard || !reportCard) throw new Error('expected two template cards');
    expect(within(reportCard).getByText('Runs on a schedule')).toBeInTheDocument();
    expect(within(approvalCard).queryByText('Runs on a schedule')).not.toBeInTheDocument();
  });

  it('calls onUseTemplate with the clicked template', async () => {
    const user = userEvent.setup();
    const onUseTemplate = vi.fn();
    renderWithIntl(
      <TemplateGallery templates={[approvalTemplate, reportTemplate]} onUseTemplate={onUseTemplate} />,
    );

    const [, reportCard] = screen.getAllByRole('article');
    if (!reportCard) throw new Error('expected two template cards');
    await user.click(within(reportCard).getByRole('button', { name: 'Use template' }));

    expect(onUseTemplate).toHaveBeenCalledTimes(1);
    expect(onUseTemplate).toHaveBeenCalledWith(reportTemplate);
  });

  it('renders nothing for an empty catalog', () => {
    const { container } = renderWithIntl(<TemplateGallery templates={[]} onUseTemplate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
