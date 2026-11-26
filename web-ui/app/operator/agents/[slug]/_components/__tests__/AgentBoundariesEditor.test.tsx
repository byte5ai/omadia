import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../../_lib/test-utils';
import type { QualityConfig } from '../../../../../_lib/builderTypes';
import { AgentBoundariesEditor } from '../AgentBoundariesEditor';

/** The editor under a parent that stores what it reports, like AgentIdentity. */
function Stateful(props: {
  readonly initial: QualityConfig;
  readonly onChange: (next: QualityConfig) => void;
}): React.ReactElement {
  const [value, setValue] = useState<QualityConfig>(props.initial);
  return (
    <AgentBoundariesEditor
      value={value}
      onChange={(next) => {
        props.onChange(next);
        setValue(next);
      }}
    />
  );
}

/**
 * #1104 — the "Grenzen" tab must state that its boundaries stack on top of
 * the Quality Guard plugin's install-wide defaults, so an operator does not
 * read this tab as the single source of truth.
 */
describe('<AgentBoundariesEditor />', () => {
  const empty: QualityConfig = { boundaries: { presets: [], custom: [] } };

  it('renders the plugin-stacking note (German copy)', () => {
    renderWithIntl(
      <AgentBoundariesEditor value={empty} onChange={vi.fn()} />,
      { locale: 'de' },
    );
    const note = screen.getByTestId('agent-boundaries-plugin-stack-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain('Quality-Guard-Plugin');
  });

  it('tells the operator custom lines reach the agent verbatim (#1101)', () => {
    renderWithIntl(
      <AgentBoundariesEditor value={empty} onChange={vi.fn()} />,
      { locale: 'de' },
    );
    // No prefix is added any more, so the field must ask for finished rules.
    expect(screen.getByLabelText('Eigene Verbote')).toHaveAttribute(
      'placeholder',
      'Gib keine Anlageberatung; verweise auf eine unabhängige Beratung.',
    );
    expect(
      screen.getByText(/als vollständiger Satz formuliert/),
    ).toBeInTheDocument();
  });

  it('renders the preset labels from the catalogue, not raw keys (#1882)', () => {
    renderWithIntl(<AgentBoundariesEditor value={empty} onChange={vi.fn()} />);
    expect(screen.getByLabelText('No financial data')).toBeInTheDocument();
    expect(screen.getByLabelText('No competitor discussion')).toBeInTheDocument();
    expect(screen.queryByText(/builder\.persona\.boundaries/)).toBeNull();
  });

  it('renders the German preset labels (#1882)', () => {
    renderWithIntl(<AgentBoundariesEditor value={empty} onChange={vi.fn()} />, {
      locale: 'de',
    });
    expect(screen.getByLabelText('Keine Finanzdaten')).toBeInTheDocument();
  });

  it('keeps Enter and spaces while typing own prohibitions (#1895)', async () => {
    const onChange = vi.fn();
    renderWithIntl(
      <Stateful
        initial={{ boundaries: { presets: [], custom: ['Rule one.'] } }}
        onChange={onChange}
      />,
    );
    const field = screen.getByLabelText('Own prohibitions');
    await userEvent.click(field);
    await userEvent.keyboard('{End}{Enter}No prices without a source. {Enter}Test two.  ');
    expect(field).toHaveValue('Rule one.\nNo prices without a source. \nTest two.  ');
    const last = onChange.mock.calls.at(-1)?.[0] as QualityConfig;
    expect(last.boundaries?.custom).toEqual([
      'Rule one.',
      'No prices without a source.',
      'Test two.',
    ]);
    await userEvent.tab();
    expect(field).toHaveValue('Rule one.\nNo prices without a source.\nTest two.');
  });

  it('tells an unset anti-flattery level apart from off and can clear it (#1894)', async () => {
    const onChange = vi.fn();
    renderWithIntl(
      <Stateful initial={{ sycophancy: 'high' }} onChange={onChange} />,
    );
    const select = screen.getByLabelText('Anti-flattery guard');
    expect(select).toHaveValue('high');
    await userEvent.selectOptions(select, 'Not set (the Quality Guard default applies)');
    const last = onChange.mock.calls.at(-1)?.[0] as QualityConfig;
    expect(last).not.toHaveProperty('sycophancy');
    expect(select).toHaveValue('');
  });

  it('shows an agent without a level as unset, not as off (#1894)', () => {
    renderWithIntl(<AgentBoundariesEditor value={empty} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Anti-flattery guard')).toHaveValue('');
  });

  it('says the agent settings replace the Quality Guard values (#1894)', () => {
    renderWithIntl(<AgentBoundariesEditor value={empty} onChange={vi.fn()} />);
    expect(
      screen.getByTestId('agent-boundaries-plugin-stack-note').textContent,
    ).toContain('replaces');
  });
});
