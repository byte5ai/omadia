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
    expect(screen.getByText(approvalTemplate.description as string)).toBeInTheDocument();
    expect(screen.getByText('approval')).toBeInTheDocument();
    expect(screen.getByText('Weekly report')).toBeInTheDocument();
    expect(screen.getByText(reportTemplate.description as string)).toBeInTheDocument();
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

  // Manifest-borne localization (#429 review): metadata may be { en, de? } records and
  // must render in the active locale with en as the fallback.
  const localizedTemplate: ConductorTemplate = {
    ...reportTemplate,
    id: 'weekly-report-localized',
    name: { en: 'Weekly report', de: 'Wochenbericht' },
    description: {
      en: 'Compile and deliver a status report every week.',
      de: 'Erstellt und liefert jede Woche einen Statusbericht.',
    },
    useCase: { en: 'reporting', de: 'Berichtswesen' },
  };

  it('renders German template metadata under the de locale', () => {
    renderWithIntl(<TemplateGallery templates={[localizedTemplate]} onUseTemplate={vi.fn()} />, { locale: 'de' });

    expect(screen.getByText('Wochenbericht')).toBeInTheDocument();
    expect(screen.getByText('Erstellt und liefert jede Woche einen Statusbericht.')).toBeInTheDocument();
    expect(screen.getByText('Berichtswesen')).toBeInTheDocument();
    expect(screen.queryByText('Weekly report')).not.toBeInTheDocument();
    expect(screen.queryByText('reporting')).not.toBeInTheDocument();
  });

  it('falls back to English under de for untranslated fields and plain-string manifests', () => {
    const partiallyLocalized: ConductorTemplate = {
      ...localizedTemplate,
      id: 'weekly-report-partial',
      name: { en: 'Weekly report' }, // no de entry → en fallback
      description: 'Compile and deliver a status report every week.', // plain string passes through
      useCase: { en: 'reporting', de: '  ' }, // blank de entry → en fallback
    };
    renderWithIntl(<TemplateGallery templates={[partiallyLocalized]} onUseTemplate={vi.fn()} />, { locale: 'de' });

    expect(screen.getByText('Weekly report')).toBeInTheDocument();
    expect(screen.getByText('Compile and deliver a status report every week.')).toBeInTheDocument();
    expect(screen.getByText('reporting')).toBeInTheDocument();
  });

  it('resolves the localized metadata to English under the default en locale', () => {
    renderWithIntl(<TemplateGallery templates={[localizedTemplate]} onUseTemplate={vi.fn()} />);

    expect(screen.getByText('Weekly report')).toBeInTheDocument();
    expect(screen.queryByText('Wochenbericht')).not.toBeInTheDocument();
  });
});
