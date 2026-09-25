import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../../_lib/test-utils';
import type { PreviewStreamEvent } from '../../../../../_lib/builderTypes';
import { PreviewChatPane } from '../PreviewChatPane';

/**
 * OM-101 / #1077 — the preview chat's missing-LLM-access branch.
 *
 * Same contract as the builder chat (see `BuilderChatPane.llmAccess.test.tsx`):
 * `builder.llm_access_missing` names the missing access instead of echoing
 * the provider's "API key is invalid"; any other error code is humanised.
 * The preview pane has its own copy of the branch, so it gets its own pin.
 * Only the stream and the secrets-status bootstrap are mocked.
 */

const { mockStreamPreviewTurn, mockGetPreviewSecretsStatus } = vi.hoisted(() => ({
  mockStreamPreviewTurn: vi.fn(),
  mockGetPreviewSecretsStatus: vi.fn(),
}));

vi.mock('../../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../_lib/api')>()),
  streamPreviewTurn: mockStreamPreviewTurn,
  getPreviewSecretsStatus: mockGetPreviewSecretsStatus,
}));

const LLM_ACCESS_MISSING =
  'The plugin builder needs LLM access (an API key or a connected subscription).';

function streamOf(...events: PreviewStreamEvent[]): void {
  mockStreamPreviewTurn.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

function renderPane(locale: 'en' | 'de' = 'en'): void {
  renderWithIntl(<PreviewChatPane draftId="d1" initialTranscript={[]} setupFields={[]} />, {
    locale,
  });
}

function sendMessage(label: string, text: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('<PreviewChatPane /> — missing LLM access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetPreviewSecretsStatus.mockResolvedValue({ keys: [] });
  });

  it('names the missing LLM access instead of the raw provider text', async () => {
    streamOf({
      type: 'error',
      code: 'builder.llm_access_missing',
      message: 'API key is invalid',
    });
    renderPane();
    sendMessage('Preview message', 'test the agent');

    expect(await screen.findByText(LLM_ACCESS_MISSING)).toBeInTheDocument();
    expect(screen.queryByText(/API key is invalid/)).not.toBeInTheDocument();
    expect(mockStreamPreviewTurn).toHaveBeenCalledWith(
      'd1',
      'test the agent',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('keeps humanising every other provider error', async () => {
    streamOf({
      type: 'error',
      code: 'preview.provider_error',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
    });
    renderPane();
    sendMessage('Preview message', 'hello');

    expect(await screen.findByText('Rate limited')).toBeInTheDocument();
    expect(screen.queryByText(LLM_ACCESS_MISSING)).not.toBeInTheDocument();
  });

  it('renders the German sentence from de.json', async () => {
    streamOf({
      type: 'error',
      code: 'builder.llm_access_missing',
      message: 'API key is invalid',
    });
    renderPane('de');
    sendMessage('Preview-Nachricht', 'hallo');

    expect(
      await screen.findByText(
        'Der Plugin-Builder braucht einen LLM-Zugang (API-Key oder verbundenes Abo).',
      ),
    ).toBeInTheDocument();
  });
});
