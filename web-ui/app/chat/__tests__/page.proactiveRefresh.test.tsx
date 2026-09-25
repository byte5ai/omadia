import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import ChatPage from '../page';

/**
 * #1071 — a routine created from a chat delivers into that chat on the
 * server. The sessions provider lives in the root layout and hydrates once per
 * full page load, so opening /chat inside the app (e.g. from /routines) must
 * re-read the active chat or the delivery never shows.
 */
const { mockRefreshProactive, ctx } = vi.hoisted(() => ({
  mockRefreshProactive: vi.fn(),
  ctx: { hydrating: false, activeId: 's1' },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('../../_lib/streamStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/streamStore')>()),
  useStreamStore: () => ({
    startTurn: vi.fn(),
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
    const session = { id: ctx.activeId, title: 'Session', messages: [], updatedAt: 0, createdAt: 0 };
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
      mutateById: vi.fn(),
      refreshProactive: mockRefreshProactive,
    };
  },
}));

describe('chat page — routine delivery re-read (#1071)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.hydrating = false;
    ctx.activeId = 's1';
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
});
