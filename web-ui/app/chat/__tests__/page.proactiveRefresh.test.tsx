import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSession, Message } from '../../_lib/chatSessions';
import { renderWithIntl } from '../../_lib/test-utils';
import ChatPage from '../page';

/**
 * #1071 — a routine created from a chat delivers into that chat on the
 * server. The sessions provider lives in the root layout and hydrates once per
 * full page load, so opening /chat inside the app (e.g. from /routines) must
 * re-read the active chat or the delivery never shows.
 */
const { mockRefreshProactive, mockMutateById, mockStartTurn, ctx } = vi.hoisted(() => ({
  mockRefreshProactive: vi.fn(),
  mockMutateById: vi.fn(),
  mockStartTurn: vi.fn(),
  ctx: { hydrating: false, activeId: 's1', messages: [] as unknown[] },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('../../_lib/streamStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/streamStore')>()),
  useStreamStore: () => ({
    startTurn: mockStartTurn,
    abort: vi.fn(),
    isActive: () => false,
    get: () => undefined,
    patch: vi.fn(),
    dismiss: vi.fn(),
    records: new Map(),
  }),
  useStreamRecord: () => undefined,
}));

vi.mock('../../_lib/chatSessionsContext', () => ({
  useChatSessionsCtx: () => {
    const session = { id: ctx.activeId, title: 'Session', messages: ctx.messages, updatedAt: 0, createdAt: 0 };
    return {
      sessions: [session],
      activeId: ctx.activeId,
      activeSession: session,
      hydrating: ctx.hydrating,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      setActive: vi.fn(),
      clearMessages: vi.fn(),
      mutateById: mockMutateById,
      refreshProactive: mockRefreshProactive,
    };
  },
}));

describe('chat page — routine delivery re-read (#1071)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.hydrating = false;
    ctx.activeId = 's1';
    ctx.messages = [];
  });

  it('re-reads the active chat when the page mounts after hydration', () => {
    renderWithIntl(<ChatPage />);
    expect(mockRefreshProactive).toHaveBeenCalledWith('s1');
  });

  it('waits for hydration, then re-reads the active chat', () => {
    ctx.hydrating = true;
    const view = renderWithIntl(<ChatPage />);
    expect(mockRefreshProactive).not.toHaveBeenCalled();

    ctx.hydrating = false;
    view.rerender(<ChatPage />);
    expect(mockRefreshProactive).toHaveBeenCalledWith('s1');
  });

  it('re-reads the chat the user switches to', () => {
    const view = renderWithIntl(<ChatPage />);
    mockRefreshProactive.mockClear();

    ctx.activeId = 's2';
    view.rerender(<ChatPage />);
    expect(mockRefreshProactive).toHaveBeenCalledWith('s2');
  });

  it('names a chat that holds only a routine delivery after its first real turn', async () => {
    // A cleared chat the routine delivered into since: the delivery is no
    // conversation, so the first question still names the chat.
    const delivery: Message = {
      id: 'proactive-r1-9000',
      role: 'assistant',
      content: 'Report',
      startedAt: 9_000,
      finishedAt: 9_000,
      proactive: { deliveredAt: 9_000, routineId: 'r1', routineName: 'Daily' },
    };
    ctx.messages = [delivery];
    renderWithIntl(<ChatPage />);
    const textarea = screen.getByRole('textbox', { name: '' });

    fireEvent.change(textarea, { target: { value: 'Quarterly numbers please' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(mockStartTurn).toHaveBeenCalledTimes(1);
    });
    const mutator = mockMutateById.mock.calls.at(-1)?.[1] as (s: ChatSession) => ChatSession;
    const next = mutator({ id: 's1', title: 'Session', createdAt: 0, updatedAt: 0, messages: [delivery] });
    expect(next.title).toBe('Quarterly numbers please');
  });
});
