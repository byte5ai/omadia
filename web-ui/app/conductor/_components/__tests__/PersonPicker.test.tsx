import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  searchConductorPeople,
  type ConductorPersonCandidate,
  type ConductorPeopleSearchResult,
} from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { PersonPicker } from '../PersonPicker';

vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return { ...actual, searchConductorPeople: vi.fn() };
});

const CANDIDATE: ConductorPersonCandidate = {
  principalRef: 'anna@example.com',
  displayName: 'Anna Example',
  channelType: 'teams',
  email: 'anna@example.com',
};

function Harness(props: {
  onChange: (ref: string, candidate?: ConductorPersonCandidate) => void;
  channel?: string;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const handleChange = (ref: string, candidate?: ConductorPersonCandidate): void => {
    setValue(ref);
    if (candidate) props.onChange(ref, candidate);
    else props.onChange(ref);
  };
  return (
    <PersonPicker
      channel={props.channel}
      value={value}
      onChange={handleChange}
    />
  );
}

function successfulResult(partial = false): ConductorPeopleSearchResult {
  return { people: [CANDIDATE], partial, channelTypes: ['teams'] };
}

const originalConsoleError = console.error;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchConductorPeople).mockReset();
  vi.spyOn(console, 'error').mockImplementation((message: unknown, ...details: unknown[]) => {
    const values = [message, ...details];
    if (values.some((value) => String(value).includes('MISSING_MESSAGE'))) return;
    originalConsoleError(message, ...details);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PersonPicker', () => {
  it('searches after the debounce and renders candidates with the channel filter', async () => {
    vi.mocked(searchConductorPeople).mockResolvedValue(successfulResult());
    renderWithIntl(<Harness channel="teams" onChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');

    expect(await screen.findAllByTestId('person-picker-option')).toHaveLength(1);
    expect(searchConductorPeople).toHaveBeenCalledWith(
      'an',
      expect.objectContaining({ channel: 'teams', limit: 8 }),
    );
  });

  it('selects a candidate with its full object and closes the list', async () => {
    const onChange = vi.fn();
    vi.mocked(searchConductorPeople).mockResolvedValue(successfulResult());
    renderWithIntl(<Harness onChange={onChange} />);
    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');

    await userEvent.click(await screen.findByTestId('person-picker-option'));

    expect(onChange).toHaveBeenLastCalledWith(CANDIDATE.principalRef, CANDIDATE);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(searchConductorPeople).toHaveBeenCalledTimes(1);
  });

  it('emits raw free text without a candidate on every change', async () => {
    const onChange = vi.fn();
    renderWithIntl(<Harness onChange={onChange} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), 'abc');

    expect(onChange).toHaveBeenNthCalledWith(1, 'a');
    expect(onChange).toHaveBeenNthCalledWith(2, 'ab');
    expect(onChange).toHaveBeenNthCalledWith(3, 'abc');
  });

  it('shows the partial-results hint', async () => {
    vi.mocked(searchConductorPeople).mockResolvedValue(successfulResult(true));
    renderWithIntl(<Harness onChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');

    expect(await screen.findByTestId('person-picker-partial')).toBeInTheDocument();
  });

  it('does not search for a query shorter than two trimmed characters', async () => {
    renderWithIntl(<Harness onChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), ' a');
    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(searchConductorPeople).not.toHaveBeenCalled();
  });

  it('shows loading and then the no-results state for an empty result', async () => {
    let resolveSearch: ((value: ConductorPeopleSearchResult) => void) | undefined;
    vi.mocked(searchConductorPeople).mockImplementation(
      () => new Promise<ConductorPeopleSearchResult>((resolve) => {
        resolveSearch = resolve;
      }),
    );
    renderWithIntl(<Harness onChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');
    expect(screen.getByTestId('person-picker-loading')).toBeInTheDocument();
    await waitFor(() => expect(resolveSearch).toBeDefined());
    resolveSearch?.({ people: [], partial: false, channelTypes: [] });

    expect(await screen.findByTestId('person-picker-empty')).toBeInTheDocument();
  });

  it('closes the suggestion list on Escape', async () => {
    vi.mocked(searchConductorPeople).mockResolvedValue(successfulResult());
    renderWithIntl(<Harness onChange={vi.fn()} />);
    const input = screen.getByTestId('person-picker-input');
    await userEvent.type(input, 'an');
    await screen.findByTestId('person-picker-option');

    await userEvent.type(input, '{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders a localized failure state without exposing the raw error', async () => {
    vi.mocked(searchConductorPeople).mockRejectedValue(
      new Error('private directory failure'),
    );
    renderWithIntl(<Harness onChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');

    expect(await screen.findByTestId('person-picker-error')).toBeInTheDocument();
    expect(screen.queryByText('private directory failure')).not.toBeInTheDocument();
  });

  it('treats a malformed people array as a localized failure', async () => {
    vi.mocked(searchConductorPeople).mockResolvedValue({
      people: null,
      partial: false,
      channelTypes: [],
    } as unknown as ConductorPeopleSearchResult);
    renderWithIntl(<Harness onChange={vi.fn()} />);

    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');

    expect(await screen.findByTestId('person-picker-error')).toBeInTheDocument();
  });

  it('aborts an active request when a newer query supersedes it', async () => {
    vi.mocked(searchConductorPeople).mockImplementation(() => new Promise(() => undefined));
    renderWithIntl(<Harness onChange={vi.fn()} />);
    const input = screen.getByTestId('person-picker-input');
    await userEvent.type(input, 'an');
    await waitFor(() => expect(searchConductorPeople).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(searchConductorPeople).mock.calls[0]?.[1]?.signal;

    await userEvent.type(input, 'n');

    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(true);
  });

  it('aborts an active request on unmount', async () => {
    vi.mocked(searchConductorPeople).mockImplementation(() => new Promise(() => undefined));
    const view = renderWithIntl(<Harness onChange={vi.fn()} />);
    await userEvent.type(screen.getByTestId('person-picker-input'), 'an');
    await waitFor(() => expect(searchConductorPeople).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(searchConductorPeople).mock.calls[0]?.[1]?.signal;

    view.unmount();

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });
});
