import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../../_lib/test-utils';
import type { BuilderTurnEvent } from '../../../../../_lib/builderTypes';
import { BuilderChatPane } from '../BuilderChatPane';

/**
 * #2214 / #1804 — Stop ends the turn on the server, and the input unlocks
 * only once the stream has closed. A busy draft (409) re-attaches to the
 * running turn and gives the unsent message back.
 */

const { mockStreamBuilderTurn, mockStopBuilderTurn } = vi.hoisted(() => ({
  mockStreamBuilderTurn: vi.fn(),
  mockStopBuilderTurn: vi.fn(),
}));

vi.mock('../../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../_lib/api')>()),
  streamBuilderTurn: mockStreamBuilderTurn,
  stopBuilderTurn: mockStopBuilderTurn,
}));

function sendMessage(text: string): void {
  const input = screen.getByLabelText('Builder message');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('<BuilderChatPane /> — stop + busy draft (#2214)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops the turn on the server and unlocks after the stopped frame', async () => {
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockStreamBuilderTurn.mockImplementation(async function* () {
      yield { type: 'turn_started', turnId: 't1' } satisfies BuilderTurnEvent;
      await stopped;
      yield {
        type: 'error',
        code: 'builder.turn_stopped',
        message: 'builder turn was stopped',
      } satisfies BuilderTurnEvent;
    });
    mockStopBuilderTurn.mockImplementation(async () => {
      finish();
      return { status: 'stopped', turnId: 't1' };
    });

    renderWithIntl(<BuilderChatPane draftId="d1" model="sonnet" initialTranscript={[]} />);
    sendMessage('long task');

    const stop = await screen.findByRole('button', { name: /Stop/ });
    expect(screen.getByLabelText('Builder message')).toBeDisabled();
    await act(async () => {
      fireEvent.click(stop);
    });

    expect(mockStopBuilderTurn).toHaveBeenCalledWith('d1', 't1');
    await waitFor(() => expect(screen.getByLabelText('Builder message')).not.toBeDisabled());
    // A stop is not an error.
    expect(screen.queryByText(/builder turn was stopped/)).not.toBeInTheDocument();
  });

  it('re-attaches to the running turn on a busy draft and keeps the message', async () => {
    mockStreamBuilderTurn.mockImplementation(async function* (
      _draftId: string,
      _message: string,
      opts: { onBusy?: (turnId: string) => void },
    ) {
      opts.onBusy?.('running-turn');
      yield { type: 'turn_started', turnId: 'running-turn' } satisfies BuilderTurnEvent;
      yield { type: 'chat_message', role: 'user', text: 'earlier message' } satisfies BuilderTurnEvent;
      yield { type: 'chat_message', role: 'assistant', text: 'earlier answer' } satisfies BuilderTurnEvent;
      yield { type: 'turn_done', turnId: 'running-turn' } satisfies BuilderTurnEvent;
    });

    renderWithIntl(
      <BuilderChatPane
        draftId="d1"
        model="sonnet"
        initialTranscript={[{ role: 'user', content: 'earlier message', timestamp: 1 }]}
      />,
    );
    sendMessage('my new message');

    expect(await screen.findByText(/still running on this draft/)).toBeInTheDocument();
    expect(await screen.findByText('earlier answer')).toBeInTheDocument();
    // The running turn's user message was loaded already: shown once.
    expect(screen.getAllByText('earlier message')).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByLabelText('Builder message')).toHaveValue('my new message'),
    );
  });

  it('unlocks at once when the turn had already ended (not_running)', async () => {
    mockStreamBuilderTurn.mockImplementation(async function* () {
      yield { type: 'turn_started', turnId: 't1' } satisfies BuilderTurnEvent;
      await new Promise<void>(() => {});
    });
    mockStopBuilderTurn.mockResolvedValue({ status: 'not_running', turnId: 't1' });

    renderWithIntl(<BuilderChatPane draftId="d1" model="sonnet" initialTranscript={[]} />);
    sendMessage('anything');
    const stop = await screen.findByRole('button', { name: /Stop/ });
    await act(async () => {
      fireEvent.click(stop);
    });
    await waitFor(() => expect(screen.getByLabelText('Builder message')).not.toBeDisabled());
  });

  it('says so when the stop request fails, and drops the connection', async () => {
    mockStreamBuilderTurn.mockImplementation(async function* () {
      yield { type: 'turn_started', turnId: 't1' } satisfies BuilderTurnEvent;
      await new Promise<void>(() => {});
    });
    mockStopBuilderTurn.mockRejectedValue(new Error('offline'));

    renderWithIntl(<BuilderChatPane draftId="d1" model="sonnet" initialTranscript={[]} />);
    sendMessage('anything');
    const stop = await screen.findByRole('button', { name: /Stop/ });
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(
      await screen.findByText('Could not stop the turn on the server: offline'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Builder message')).not.toBeDisabled();
  });
});
