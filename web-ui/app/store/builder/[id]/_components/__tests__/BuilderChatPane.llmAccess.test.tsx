import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../../_lib/test-utils';
import type { BuilderTurnEvent } from '../../../../../_lib/builderTypes';
import { BuilderChatPane } from '../BuilderChatPane';

/**
 * OM-101 / #1077 — the builder chat's missing-LLM-access branch.
 *
 * A builder turn on an install with no API key and no connected subscription
 * used to surface the provider's raw "API key is invalid" — for a key the
 * operator never needed. The middleware now tags that case with
 * `builder.llm_access_missing`, and the pane names what is actually missing.
 * Every other error code still goes through the provider-error humaniser.
 * Only the stream is mocked; the pane itself renders for real.
 */

const { mockStreamBuilderTurn } = vi.hoisted(() => ({
  mockStreamBuilderTurn: vi.fn(),
}));

vi.mock('../../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../_lib/api')>()),
  streamBuilderTurn: mockStreamBuilderTurn,
}));

const LLM_ACCESS_MISSING =
  'The plugin builder needs LLM access (an API key or a connected subscription).';

function streamOf(...events: BuilderTurnEvent[]): void {
  mockStreamBuilderTurn.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

function sendMessage(label: string, text: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('<BuilderChatPane /> — missing LLM access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('names the missing LLM access instead of the raw provider text', async () => {
    streamOf(
      { type: 'turn_started', turnId: 't1' },
      { type: 'error', code: 'builder.llm_access_missing', message: 'API key is invalid' },
    );
    renderWithIntl(<BuilderChatPane draftId="d1" model="sonnet" initialTranscript={[]} />);
    sendMessage('Builder message', 'build me a plugin');

    expect(await screen.findByText(LLM_ACCESS_MISSING)).toBeInTheDocument();
    expect(screen.queryByText(/API key is invalid/)).not.toBeInTheDocument();
    expect(mockStreamBuilderTurn).toHaveBeenCalledWith(
      'd1',
      'build me a plugin',
      expect.objectContaining({ model: 'sonnet' }),
    );
  });

  it('keeps humanising every other provider error', async () => {
    streamOf({
      type: 'error',
      code: 'builder.provider_error',
      message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    });
    renderWithIntl(<BuilderChatPane draftId="d1" model="sonnet" initialTranscript={[]} />);
    sendMessage('Builder message', 'hello');

    expect(await screen.findByText('Overloaded')).toBeInTheDocument();
    expect(screen.queryByText(LLM_ACCESS_MISSING)).not.toBeInTheDocument();
  });

  it('renders the German sentence from de.json', async () => {
    streamOf({ type: 'error', code: 'builder.llm_access_missing', message: 'API key is invalid' });
    renderWithIntl(<BuilderChatPane draftId="d1" model="sonnet" initialTranscript={[]} />, {
      locale: 'de',
    });
    sendMessage('Builder-Nachricht', 'hallo');

    expect(
      await screen.findByText(
        'Der Plugin-Builder braucht einen LLM-Zugang (API-Key oder verbundenes Abo).',
      ),
    ).toBeInTheDocument();
  });
});
