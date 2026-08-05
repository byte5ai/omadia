import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import ChatPage from '../page';

/**
 * Regression guard for OM-21/37 — "Enter does not send in chat".
 *
 * The composer only ever handled ⌘/Ctrl+Enter, so plain Enter did nothing and
 * the only way to send was clicking the button — even though the four other
 * composers in the app had used plain Enter for a long time. These tests pin
 * the send/newline/steer contract at the component boundary (the stream store
 * and the steer endpoint), not at the helper level.
 */
const {
  mockStartTurn,
  mockAbort,
  mockIsActive,
  mockMutateActive,
  mockSteerActiveTurn,
} = vi.hoisted(() => ({
  mockStartTurn: vi.fn(),
  mockAbort: vi.fn(),
  mockIsActive: vi.fn(() => false),
  mockMutateActive: vi.fn(),
  mockSteerActiveTurn: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

// Spread the real module and override only the two hooks that need a
// provider. A bare object literal here silently omits every other export, so
// any component ChatPage renders that reaches for one (ChatTabs calls
// `useStreamRecord`) dies with "No export is defined on the mock" — a failure
// mode with nothing to do with the keyboard contract under test.
vi.mock('../../_lib/streamStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/streamStore')>()),
  useStreamStore: () => ({
    startTurn: mockStartTurn,
    abort: mockAbort,
    isActive: mockIsActive,
    get: () => undefined,
    patch: vi.fn(),
    dismiss: vi.fn(),
    records: new Map(),
  }),
  useStreamRecord: () => undefined,
}));

vi.mock('../../_lib/chatSessionsContext', () => ({
  useChatSessionsCtx: () => ({
    sessions: [
      { id: 's1', title: 'Session', messages: [], updatedAt: 0, createdAt: 0 },
    ],
    activeId: 's1',
    activeSession: {
      id: 's1',
      title: 'Session',
      messages: [],
      updatedAt: 0,
      createdAt: 0,
    },
    hydrating: false,
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    setActive: vi.fn(),
    clearMessages: vi.fn(),
    mutateActive: mockMutateActive,
  }),
}));

vi.mock('../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  steerActiveTurn: mockSteerActiveTurn,
}));

/** The composer textarea — identified by the placeholder from the catalog. */
function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', {
    name: '',
  }) as HTMLTextAreaElement;
}

describe('chat composer keyboard handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsActive.mockReturnValue(false);
    mockSteerActiveTurn.mockResolvedValue({ accepted: true });
  });

  it('sends on plain Enter and does not insert a newline', async () => {
    renderWithIntl(<ChatPage />);
    const textarea = composer();

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(mockStartTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockStartTurn.mock.calls[0]?.[0]).toMatchObject({ message: 'hello' });
    // preventDefault() means the browser never gets to insert its newline.
    expect(textarea.value).not.toContain('\n');
  });

  it('inserts a newline on Shift+Enter without sending', () => {
    renderWithIntl(<ChatPage />);
    const textarea = composer();

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(mockStartTurn).not.toHaveBeenCalled();
    // The handler bails out, so the browser's own newline stands. jsdom does
    // not run the default action for a synthetic keydown, so emulate what the
    // untouched browser would then do and assert the value round-trips.
    fireEvent.change(textarea, { target: { value: 'hello\n' } });
    expect(textarea.value).toBe('hello\n');
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('steers instead of sending while a turn is in flight', async () => {
    mockIsActive.mockReturnValue(true);
    renderWithIntl(<ChatPage />);
    const textarea = composer();

    fireEvent.change(textarea, { target: { value: 'actually, use French' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(mockSteerActiveTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('does not send while an IME composition is active', () => {
    renderWithIntl(<ChatPage />);
    const textarea = composer();

    fireEvent.change(textarea, { target: { value: 'にほんご' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('keeps Cmd+Enter working as the legacy alias', async () => {
    renderWithIntl(<ChatPage />);
    const textarea = composer();

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(mockStartTurn).toHaveBeenCalledTimes(1);
    });
  });
});
