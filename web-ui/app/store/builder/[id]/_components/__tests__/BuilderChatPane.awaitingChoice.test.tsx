import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../../_lib/test-utils';
import type { BuilderTurnEvent } from '../../../../../_lib/builderTypes';
import { BuilderChatPane } from '../BuilderChatPane';

/**
 * #1738 — while the builder waits for the operator's answer to an
 * `ask_user_choice` card, the turn is still in flight and the heartbeat's
 * "last activity" gap keeps growing. The liveness row must say the builder is
 * waiting for the choice, not that it is "likely stuck — press Stop?" (Stop
 * would abort the open question). Only the stream is mocked.
 */

const { mockStreamBuilderTurn } = vi.hoisted(() => ({
  mockStreamBuilderTurn: vi.fn(),
}));

vi.mock('../../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../_lib/api')>()),
  streamBuilderTurn: mockStreamBuilderTurn,
}));

const QUIET_HEARTBEAT: BuilderTurnEvent = {
  type: 'heartbeat',
  sinceLastActivityMs: 101_000,
  currentIteration: 1,
  toolCallsThisIter: 1,
};

const PENDING_CHOICE = {
  choiceId: 'c1',
  question: 'Which weather source?',
  options: [
    { value: 'owm', label: 'OpenWeatherMap' },
    { value: 'dwd', label: 'DWD' },
  ],
};

/** Yields the given events, then stays open like a turn blocked on a choice. */
function openStreamOf(...events: BuilderTurnEvent[]): void {
  mockStreamBuilderTurn.mockImplementation(async function* () {
    for (const ev of events) yield ev;
    await new Promise<never>(() => undefined);
  });
}

function sendMessage(label: string, text: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('<BuilderChatPane /> — waiting for a user choice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openStreamOf({ type: 'turn_started', turnId: 't1' }, QUIET_HEARTBEAT);
  });

  it('says it waits for the choice instead of "likely stuck"', async () => {
    renderWithIntl(
      <BuilderChatPane
        draftId="d1"
        model="opus"
        initialTranscript={[]}
        pendingUserChoice={PENDING_CHOICE}
      />,
    );
    sendMessage('Builder message', 'build a weather agent');

    expect(await screen.findByText(/waiting for your choice/)).toBeInTheDocument();
    expect(screen.queryByText(/likely stuck/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Builder message')).toHaveAttribute(
      'placeholder',
      'Builder is waiting for your choice above …',
    );
  });

  it('still flags a quiet turn without an open choice as likely stuck', async () => {
    renderWithIntl(<BuilderChatPane draftId="d1" model="opus" initialTranscript={[]} />);
    sendMessage('Builder message', 'build a weather agent');

    expect(await screen.findByText(/likely stuck/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for your choice/)).not.toBeInTheDocument();
  });

  it('renders the German texts from de.json', async () => {
    renderWithIntl(
      <BuilderChatPane
        draftId="d1"
        model="opus"
        initialTranscript={[]}
        pendingUserChoice={PENDING_CHOICE}
      />,
      { locale: 'de' },
    );
    sendMessage('Builder-Nachricht', 'baue einen Wetter-Agenten');

    expect(await screen.findByText(/wartet auf deine Auswahl/)).toBeInTheDocument();
    expect(screen.queryByText(/vermutlich hängt/)).not.toBeInTheDocument();
  });
});
