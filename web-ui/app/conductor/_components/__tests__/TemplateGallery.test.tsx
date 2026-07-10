import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  approveConductorTemplate,
  deleteConductorTemplate,
  rejectConductorTemplate,
  submitConductorTemplate,
  type ConductorTemplate,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { TemplateGallery } from '../TemplateGallery';

// Partial mock (#478 F2): only the four mutation calls are stubbed — the wire
// types, ApiError and resolveConductorText stay real.
vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    approveConductorTemplate: vi.fn(),
    rejectConductorTemplate: vi.fn(),
    submitConductorTemplate: vi.fn(),
    deleteConductorTemplate: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(approveConductorTemplate).mockResolvedValue({ template: null });
  vi.mocked(rejectConductorTemplate).mockResolvedValue({ template: null });
  vi.mocked(submitConductorTemplate).mockResolvedValue({ template: {} as ConductorTemplate });
  vi.mocked(deleteConductorTemplate).mockResolvedValue(undefined);
});

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

describe('<TemplateGallery />', () => {
  it('renders one card per template with name, description and use-case tag', () => {
    renderWithIntl(
      <TemplateGallery templates={[approvalTemplate, reportTemplate]} onUseTemplate={vi.fn()} />,
    );

    const [approvalCard, reportCard] = screen.getAllByRole('article');
    if (!approvalCard || !reportCard) throw new Error('expected two template cards');
    // Use-case text also appears in the filter chips (#478), so assert per card.
    expect(within(approvalCard).getByText('Expense approval')).toBeInTheDocument();
    expect(within(approvalCard).getByText(approvalTemplate.description as string)).toBeInTheDocument();
    expect(within(approvalCard).getByText('approval')).toBeInTheDocument();
    expect(within(reportCard).getByText('Weekly report')).toBeInTheDocument();
    expect(within(reportCard).getByText(reportTemplate.description as string)).toBeInTheDocument();
    expect(within(reportCard).getByText('reporting')).toBeInTheDocument();
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

// -----------------------------------------------------------------------------
// #478 F2 — provenance facets, pending-review queue, search, manage actions
// -----------------------------------------------------------------------------

const VIEWER = 'user-1';

/** Composite-catalog fixtures: bundled (v1 fixtures above carry no `source`),
 *  own private, foreign shared, foreign PENDING (the reviewer-queue case) and
 *  a plugin template. */
const minePrivate: ConductorTemplate = {
  ...approvalTemplate,
  id: 'mine-private',
  name: 'My private flow',
  useCase: 'approval',
  source: 'user',
  status: 'private',
  createdBy: VIEWER,
  version: 1,
  latestVersion: 1,
  instantiationCount: 0,
};

const foreignShared: ConductorTemplate = {
  ...approvalTemplate,
  id: 'foreign-shared',
  name: 'Foreign shared flow',
  useCase: 'approval',
  source: 'user',
  status: 'shared',
  createdBy: 'someone-else',
  version: 2,
  latestVersion: 2,
  instantiationCount: 12,
};

const foreignPending: ConductorTemplate = {
  ...approvalTemplate,
  id: 'foreign-pending',
  name: 'Foreign pending flow',
  useCase: 'approval',
  source: 'user',
  status: 'pending',
  createdBy: 'operator-b',
  version: 1,
  latestVersion: 1,
  instantiationCount: 0,
};

const pluginTemplate: ConductorTemplate = {
  ...reportTemplate,
  id: 'plugin:acme:weekly',
  name: 'Plugin weekly flow',
  source: 'plugin',
  version: 1,
  latestVersion: 1,
  instantiationCount: 3,
};

const CATALOG = [approvalTemplate, reportTemplate, minePrivate, foreignShared, foreignPending, pluginTemplate];

function cardNames(): string[] {
  return screen.getAllByRole('article').map((card) => within(card).getByRole('heading').textContent ?? '');
}

describe('<TemplateGallery /> facets, search and manage actions (#478)', () => {
  it('filters by provenance facet: bundled / plugin split, "My templates" only viewer-owned', async () => {
    const user = userEvent.setup();
    renderWithIntl(<TemplateGallery templates={CATALOG} viewer={VIEWER} onUseTemplate={vi.fn()} />);

    // Default facet: everything visible.
    expect(screen.getAllByRole('article')).toHaveLength(CATALOG.length);

    await user.click(screen.getByRole('button', { name: 'Bundled' }));
    expect(cardNames()).toEqual(['Expense approval', 'Weekly report']);

    await user.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(cardNames()).toEqual(['Plugin weekly flow']);

    // Viewer-owned only — foreign shared/pending user templates are excluded.
    await user.click(screen.getByRole('button', { name: 'My templates' }));
    expect(cardNames()).toEqual(['My private flow']);

    await user.click(screen.getByRole('button', { name: 'Shared' }));
    expect(cardNames()).toEqual(['Foreign shared flow']);
  });

  it('lists a pending template by ANOTHER operator under "Pending review" with working Approve', async () => {
    const user = userEvent.setup();
    const onCatalogChanged = vi.fn();
    const { rerender } = renderWithIntl(
      <TemplateGallery templates={CATALOG} viewer={VIEWER} onUseTemplate={vi.fn()} onCatalogChanged={onCatalogChanged} />,
    );

    // Facet label carries the waiting-count badge.
    await user.click(screen.getByRole('button', { name: /Pending review/ }));
    expect(cardNames()).toEqual(['Foreign pending flow']);

    const card = screen.getByRole('article');
    // Reviewer context: submitter + both direct review actions, for a NON-author.
    expect(within(card).getByText('Submitted by operator-b')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Reject' })).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onCatalogChanged).toHaveBeenCalledTimes(1));
    expect(approveConductorTemplate).toHaveBeenCalledWith('foreign-pending');

    // The page refetches on onCatalogChanged; after the refresh the template is
    // shared and surfaces under the Shared facet.
    const refreshed = CATALOG.map((tpl) =>
      tpl.id === 'foreign-pending' ? { ...tpl, status: 'shared' as const } : tpl,
    );
    rerender(<TemplateGallery templates={refreshed} viewer={VIEWER} onUseTemplate={vi.fn()} onCatalogChanged={onCatalogChanged} />);
    expect(screen.getByText('No templates waiting for review')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Shared' }));
    expect(cardNames()).toEqual(['Foreign shared flow', 'Foreign pending flow']);
  });

  it('narrows by name/use-case substring search', async () => {
    const user = userEvent.setup();
    renderWithIntl(<TemplateGallery templates={CATALOG} viewer={VIEWER} onUseTemplate={vi.fn()} />);

    const search = screen.getByRole('searchbox', { name: 'Search templates' });
    await user.type(search, 'weekly');
    expect(cardNames()).toEqual(['Weekly report', 'Plugin weekly flow']);

    await user.clear(search);
    await user.type(search, 'reporting'); // use-case substring
    expect(cardNames()).toEqual(['Weekly report', 'Plugin weekly flow']);

    await user.clear(search);
    await user.type(search, 'no-such-template');
    expect(screen.getByText('No templates match your filters.')).toBeInTheDocument();
  });

  it('searches over the locale-resolved metadata with en fallback under de', async () => {
    const user = userEvent.setup();
    // localizedTemplate has a German name; reportTemplate is en-only → under de
    // it resolves (and matches) through the English fallback.
    renderWithIntl(
      <TemplateGallery templates={[localizedTemplate, reportTemplate]} viewer={VIEWER} onUseTemplate={vi.fn()} />,
      { locale: 'de' },
    );

    await user.type(screen.getByRole('searchbox', { name: 'Vorlagen durchsuchen' }), 'Wochen');
    expect(cardNames()).toEqual(['Wochenbericht']);

    await user.clear(screen.getByRole('searchbox', { name: 'Vorlagen durchsuchen' }));
    await user.type(screen.getByRole('searchbox', { name: 'Vorlagen durchsuchen' }), 'Weekly');
    expect(cardNames()).toEqual(['Weekly report']);
  });

  it('offers Submit for review only on own private cards and confirms Delete before firing', async () => {
    const user = userEvent.setup();
    const onCatalogChanged = vi.fn();
    renderWithIntl(
      <TemplateGallery templates={CATALOG} viewer={VIEWER} onUseTemplate={vi.fn()} onCatalogChanged={onCatalogChanged} />,
    );

    const cards = screen.getAllByRole('article');
    const mineCard = cards.find((c) => within(c).queryByText('My private flow'));
    const sharedCard = cards.find((c) => within(c).queryByText('Foreign shared flow'));
    const bundledCard = cards.find((c) => within(c).queryByText('Expense approval'));
    if (!mineCard || !sharedCard || !bundledCard) throw new Error('expected the fixture cards');

    // Submit + Delete only on the OWN card; nothing on foreign/bundled cards.
    expect(within(mineCard).getByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
    expect(within(sharedCard).queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument();
    expect(within(sharedCard).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(bundledCard).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    // Approve/Reject are absent on non-pending cards.
    expect(within(mineCard).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(sharedCard).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();

    // Delete asks for an inline confirm first; only the confirm fires DELETE.
    await user.click(within(mineCard).getByRole('button', { name: 'Delete' }));
    expect(deleteConductorTemplate).not.toHaveBeenCalled();
    await user.click(within(mineCard).getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(onCatalogChanged).toHaveBeenCalledTimes(1));
    expect(deleteConductorTemplate).toHaveBeenCalledWith('mine-private');
  });

  it('submits an own private template for review', async () => {
    const user = userEvent.setup();
    const onCatalogChanged = vi.fn();
    renderWithIntl(
      <TemplateGallery templates={[minePrivate]} viewer={VIEWER} onUseTemplate={vi.fn()} onCatalogChanged={onCatalogChanged} />,
    );

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(onCatalogChanged).toHaveBeenCalledTimes(1));
    expect(submitConductorTemplate).toHaveBeenCalledWith('mine-private');
  });

  it('shows version tag and instantiation count on the card', () => {
    renderWithIntl(<TemplateGallery templates={[foreignShared]} viewer={VIEWER} onUseTemplate={vi.fn()} />);

    const card = screen.getByRole('article');
    expect(within(card).getByText('v2')).toBeInTheDocument();
    expect(within(card).getByText(/Used 12×/)).toBeInTheDocument();
  });
});
