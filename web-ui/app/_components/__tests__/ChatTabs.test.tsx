import { act, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import type { ChatSession } from '../../_lib/chatSessions';
import {
  dismissSeenTurns,
  StreamStoreProvider,
  useStreamStore,
  type StreamPhase,
  type StreamRecord,
} from '../../_lib/streamStore';
import {
  ChatTabs,
  streamAriaKey,
  streamDotClass,
  streamDotGlyph,
  tabStreamState,
} from '../ChatTabs';

/**
 * Guards the in-context background-stream surfacing added for issue #286,
 * which replaced the floating `StreamToasts` overlay with a per-tab marker.
 *
 * Three things here are load-bearing and none of them is obvious from reading
 * the component, which is why they get tests rather than a code comment:
 *
 *  1. `tabStreamState`'s suppression rules — the ACTIVE tab shows nothing (its
 *     stream is already visible inline) and `aborted` shows nothing (the user
 *     stopped it themselves, so there is nothing unread to flag). Both are
 *     deliberate omissions that read as bugs to anyone who doesn't know.
 *  2. The §8 invariant that colour is never the sole signal. A regression here
 *     is invisible in review — swapping the error ring for a fill still looks
 *     fine to a trichromat — so it is asserted structurally.
 *  3. The dismiss-on-switch rule, which keys off the tab being LEFT, not the
 *     one being entered. The obvious reading of "selecting a tab marks it
 *     read" produces the opposite behaviour and reintroduces the exact re-flag
 *     this exists to prevent.
 */

function session(id: string, title: string): ChatSession {
  return {
    id,
    title,
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ChatSession;
}

function record(phase: StreamPhase): StreamRecord {
  return {
    sessionId: 's',
    phase,
    startedAt: 0,
    lastEventAt: 0,
    previewTail: '',
  };
}

describe('tabStreamState', () => {
  it('shows nothing on the active tab even while its stream runs', () => {
    expect(tabStreamState(true, record('streaming'))).toBeNull();
    expect(tabStreamState(true, record('done'))).toBeNull();
    expect(tabStreamState(true, record('error'))).toBeNull();
  });

  it('shows nothing when the session has no record at all', () => {
    expect(tabStreamState(false, undefined)).toBeNull();
  });

  it('maps every non-terminal phase to running', () => {
    const inFlight: StreamPhase[] = [
      'pending',
      'thinking',
      'streaming',
      'tool_running',
    ];
    for (const phase of inFlight) {
      expect(tabStreamState(false, record(phase))).toBe('running');
    }
  });

  it('maps done and error to their own states', () => {
    expect(tabStreamState(false, record('done'))).toBe('done');
    expect(tabStreamState(false, record('error'))).toBe('error');
  });

  it('shows nothing for a user-aborted turn', () => {
    // Deliberate: the user stopped it, so there is no unread outcome to flag.
    expect(tabStreamState(false, record('aborted'))).toBeNull();
  });
});

describe('marker styling — §8, colour is never the sole signal', () => {
  it('gives every state a distinct catalog key', () => {
    const keys = [
      streamAriaKey('running'),
      streamAriaKey('done'),
      streamAriaKey('error'),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('separates running from done on fill, not on motion alone', () => {
    // prefers-reduced-motion kills `animate-pulse` via the universal reset in
    // globals.css. If the pulse were the only difference, the two states would
    // collapse into one for every reduced-motion user.
    const running = streamDotClass('running');
    const done = streamDotClass('done');
    expect(running).toContain('ring-1');
    expect(running).not.toContain('bg-[color:var(--accent)]');
    expect(done).toContain('bg-[color:var(--accent)]');
    expect(done).not.toContain('ring-1');
  });

  it('separates error from running on a glyph, not on hue alone', () => {
    expect(streamDotGlyph('error')).not.toBe('');
    expect(streamDotGlyph('running')).toBe('');
    expect(streamDotGlyph('done')).toBe('');
  });

  it('keeps the danger token text/edge-only — never a solid fill', () => {
    const error = streamDotClass('error');
    expect(error).toContain('text-[color:var(--danger)]');
    expect(error).toContain('ring-[color:var(--danger-edge)]');
    expect(error).not.toContain('bg-[color:var(--danger)]');
  });
});

/** Drives a real <StreamStoreProvider> so the tab strip reads live records. */
function renderTabs(
  sessions: ChatSession[],
  activeId: string,
  onSelect: (id: string) => void = () => undefined,
): { store: () => ReturnType<typeof useStreamStore> } {
  let value: ReturnType<typeof useStreamStore> | null = null;
  function Capture(): null {
    value = useStreamStore();
    return null;
  }
  function Tree(): ReactElement {
    return (
      <StreamStoreProvider>
        <Capture />
        <ChatTabs
          sessions={sessions}
          activeId={activeId}
          onSelect={onSelect}
          onCreate={() => undefined}
          onClose={() => undefined}
          onRename={() => undefined}
        />
      </StreamStoreProvider>
    );
  }
  renderWithIntl(<Tree />);
  return {
    store(): ReturnType<typeof useStreamStore> {
      if (!value) throw new Error('store value never captured');
      return value;
    },
  };
}

/** Start a turn and drive it to a terminal phase through the real store. */
function finishTurn(
  store: ReturnType<typeof useStreamStore>,
  sessionId: string,
  outcome: 'done' | 'error' | 'aborted',
): void {
  act(() => {
    store.startTurn({
      sessionId,
      pendingMessageId: `${sessionId}-m1`,
      message: 'hi',
    });
  });
  act(() => {
    store.finish(sessionId, outcome);
  });
}

describe('ChatTabs rendering', () => {
  it('renders no marker for a session with no stream', () => {
    renderTabs([session('a', 'Alpha'), session('b', 'Beta')], 'a');
    expect(screen.queryByText('Response ready')).toBeNull();
    expect(screen.queryByText('Response failed')).toBeNull();
  });

  it('marks a finished background tab and leaves the active tab clean', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'done');
    expect(screen.getAllByText('Response ready').length).toBeGreaterThan(0);

    // Same outcome on the ACTIVE tab surfaces nothing.
    finishTurn(store(), 'a', 'done');
    expect(screen.getAllByText('Response ready')).toHaveLength(1);
  });

  it('carries a visible glyph for the error state', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'error');
    expect(screen.getByText('Response failed')).toBeTruthy();
    expect(screen.getByTitle('Response failed').textContent).toBe(
      streamDotGlyph('error'),
    );
  });

  it('renders nothing for an aborted background turn', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'aborted');
    expect(screen.queryByText('Response ready')).toBeNull();
    expect(screen.queryByText('Response failed')).toBeNull();
  });
});

describe('StreamAnnouncer — polite live region', () => {
  function liveRegion(): HTMLElement {
    return screen.getByRole('status');
  }

  it('exposes a polite live region', () => {
    renderTabs([session('a', 'Alpha')], 'a');
    expect(liveRegion().getAttribute('aria-live')).toBe('polite');
  });

  it('announces a background turn that finishes', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'done');
    expect(liveRegion().textContent).toBe('Beta: response ready');
  });

  it('announces a background turn that fails', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'error');
    expect(liveRegion().textContent).toBe('Beta: response failed');
  });

  it('announces a marker that was already terminal when the strip mounted', () => {
    // A turn that finished while the user sat on /admin renders its marker the
    // moment ChatTabs mounts. Seeding that silently would give the sighted
    // user a signal the screen-reader user never gets — the exact asymmetry
    // this region exists to close.
    let store: ReturnType<typeof useStreamStore> | null = null;
    function Capture(): null {
      store = useStreamStore();
      return null;
    }
    const sessions = [session('a', 'Alpha'), session('b', 'Beta')];
    function Tree({ mounted }: { mounted: boolean }): ReactElement {
      return (
        <StreamStoreProvider>
          <Capture />
          {mounted && (
            <ChatTabs
              sessions={sessions}
              activeId="a"
              onSelect={() => undefined}
              onCreate={() => undefined}
              onClose={() => undefined}
              onRename={() => undefined}
            />
          )}
        </StreamStoreProvider>
      );
    }
    const { rerender } = renderWithIntl(<Tree mounted={false} />);
    if (!store) throw new Error('store never captured');
    finishTurn(store, 'b', 'done');
    // Strip was not mounted while the turn ran — nothing could have announced.
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<Tree mounted />);
    expect(screen.getByRole('status').textContent).toBe('Beta: response ready');
  });

  it('stays silent for the active tab and for an abort', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'a', 'done');
    expect(liveRegion().textContent).toBe('');
    finishTurn(store(), 'b', 'aborted');
    expect(liveRegion().textContent).toBe('');
  });
});

describe('dismiss-on-switch', () => {
  /**
   * The regression this pins down: `handleSelect` used to inspect only the tab
   * being ENTERED. A turn the user watched finish in the foreground therefore
   * kept its `done` record, and re-flagged itself the moment they switched
   * away — the exact case the dismiss exists to prevent.
   *
   * `dismissSeenTurns` is the real production rule, imported — not a copy.
   * `handleSelect` in `app/chat/page.tsx` calls it with exactly these two
   * arguments and does nothing else but `setActive`.
   */
  function handleSelect(
    store: ReturnType<typeof useStreamStore>,
    activeId: string,
    id: string,
  ): void {
    dismissSeenTurns(store, activeId, id);
  }

  it('forgets the done record of the tab being LEFT', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'a', 'done');
    expect(store().get('a')?.phase).toBe('done');

    act(() => {
      handleSelect(store(), 'a', 'b');
    });
    expect(store().get('a')).toBeUndefined();
  });

  it('forgets the done record of the tab being ENTERED', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'done');

    act(() => {
      handleSelect(store(), 'a', 'b');
    });
    expect(store().get('b')).toBeUndefined();
  });

  it('keeps error and running records — other UI reads them', () => {
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    // The agent_unavailable banner and the inline error read the error record
    // off the store; the composer lock reads the running one.
    finishTurn(store(), 'a', 'error');
    act(() => {
      store().startTurn({
        sessionId: 'b',
        pendingMessageId: 'b-m1',
        message: 'hi',
      });
    });

    act(() => {
      handleSelect(store(), 'a', 'b');
    });
    expect(store().get('a')?.phase).toBe('error');
    expect(store().get('b')).toBeDefined();
  });

  it('forgets the leaving tab when a NEW chat is created', () => {
    // `createSession` changes activeId without going through handleSelect, so
    // the tab just left would otherwise flag itself as unread. ChatPage's
    // handleCreate calls the rule with the leaving id only.
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'a', 'done');

    act(() => {
      dismissSeenTurns(store(), 'a');
    });
    expect(store().get('a')).toBeUndefined();
  });

  it('drops a closed tab record outright so it cannot hold a store slot', () => {
    // The tab is gone, so nothing can surface the record again; leaving it
    // would occupy one of the store's 12 slots until GC.
    const { store } = renderTabs(
      [session('a', 'Alpha'), session('b', 'Beta')],
      'a',
    );
    finishTurn(store(), 'b', 'error');
    expect(store().get('b')?.phase).toBe('error');

    // Mirrors handleClose: dismiss regardless of phase, then delete.
    act(() => {
      store().dismiss('b');
    });
    expect(store().get('b')).toBeUndefined();
  });

  it('is a no-op when re-selecting the already-active tab mid-stream', () => {
    const { store } = renderTabs([session('a', 'Alpha')], 'a');
    act(() => {
      store().startTurn({
        sessionId: 'a',
        pendingMessageId: 'a-m1',
        message: 'hi',
      });
    });

    act(() => {
      handleSelect(store(), 'a', 'a');
    });
    expect(store().get('a')).toBeDefined();
  });
});

describe('tab interaction', () => {
  it('reports the selected session id', () => {
    const onSelect = vi.fn();
    renderTabs([session('a', 'Alpha'), session('b', 'Beta')], 'a', onSelect);
    fireEvent.click(screen.getByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});
