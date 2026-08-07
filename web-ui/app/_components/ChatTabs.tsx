'use client';

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import type { ChatSession } from '../_lib/chatSessions';
import { Button } from './ui/Button';
import {
  isStreamActive,
  useStreamRecord,
  useStreamStore,
  type StreamPhase,
  type StreamRecord,
} from '../_lib/streamStore';

interface ChatTabsProps {
  sessions: ChatSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  disabled?: boolean;
}

/**
 * Horizontal tab strip over the chat area. Click to switch, double-click a
 * title to rename inline, `×` to close. The close button is suppressed
 * while a turn is streaming for the active tab — killing the session out
 * from under an in-flight request leaves the backend PUT dangling.
 */
export function ChatTabs({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onClose,
  onRename,
  disabled,
}: ChatTabsProps): React.ReactElement {
  const t = useTranslations('chatTabs');
  return (
    <>
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-1 text-xs"
      role="tablist"
    >
      {sessions.map((session) => (
        <Tab
          key={session.id}
          session={session}
          active={session.id === activeId}
          onSelect={() => {
            onSelect(session.id);
          }}
          onClose={() => {
            onClose(session.id);
          }}
          onRename={(title) => {
            onRename(session.id, title);
          }}
          canClose={sessions.length > 1}
          disabled={disabled === true && session.id === activeId}
        />
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={onCreate}
        className="ml-1 shrink-0"
        title={t('newChatTitle')}
      >
        + {t('newChat')}
      </Button>
      </div>
      <StreamAnnouncer sessions={sessions} activeId={activeId} />
    </>
  );
}

/**
 * Polite live region for background turns that reach a terminal state.
 *
 * The removed `StreamToasts` overlay carried `aria-live="polite"` on its
 * container; deleting it took the only screen-reader announcement of a
 * background stream with it. This region restores it.
 *
 * It lives on the tab strip rather than back in the root layout on purpose:
 * the visible marker is scoped to `/chat`, so scoping the announcement the
 * same way keeps the two channels in step — wherever a sighted user gets a
 * signal, a screen-reader user gets one too, and neither gets a phantom
 * signal for a marker that isn't on screen. That background streams surface
 * nowhere at all off `/chat` is a consequence of the toast removal itself,
 * recorded as accepted in ADR-0006.
 */
function StreamAnnouncer({
  sessions,
  activeId,
}: {
  sessions: ChatSession[];
  activeId: string;
}): React.ReactElement {
  const t = useTranslations('chatTabs');
  const { records } = useStreamStore();
  const seenRef = useRef<Map<string, StreamPhase>>(new Map());
  const [announcement, setAnnouncement] = useState({ text: '', seq: 0 });

  useEffect(() => {
    // The first pass deliberately does NOT seed silently. A turn that finished
    // while the user sat on /admin has its marker rendered the moment the
    // strip mounts, so that is exactly when a screen-reader user should hear
    // it — suppressing it would hand the sighted user a signal the
    // screen-reader user never gets, which is the asymmetry this region
    // exists to close. Announcing on mount mirrors the markers actually on
    // screen, and re-entering /chat re-shows those same markers visually too.
    // (The store is in-memory, so a cold page load starts empty and announces
    // nothing.)
    const seen = seenRef.current;

    const fresh: string[] = [];
    for (const [sessionId, rec] of records) {
      if (seen.get(sessionId) === rec.phase) continue;
      seen.set(sessionId, rec.phase);
      // The active tab's stream is already visible inline, and it renders no
      // marker — announcing it would duplicate what the transcript shows.
      if (sessionId === activeId) continue;
      // Only the two phases that render a marker are announced. `aborted` is
      // the user's own action and shows nothing (ADR-0006).
      if (rec.phase !== 'done' && rec.phase !== 'error') continue;
      const title = sessions.find((s) => s.id === sessionId)?.title;
      if (title === undefined) continue;
      fresh.push(
        t(
          rec.phase === 'error' ? 'streamErrorAnnounce' : 'streamDoneAnnounce',
          { title },
        ),
      );
    }
    // Forget GC'd records so a later turn on the same session announces again
    // instead of being swallowed as "unchanged".
    for (const sessionId of [...seen.keys()]) {
      if (!records.has(sessionId)) seen.delete(sessionId);
    }

    if (fresh.length > 0) {
      // Announcing IS the effect here: the trigger is a store transition, not
      // a render, and the text must land in the live region only after the
      // record has actually flipped. Deriving it during render would replay
      // every announcement on every unrelated re-render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnnouncement((prev) => ({ text: fresh.join(' '), seq: prev.seq + 1 }));
    }
  }, [records, sessions, activeId, t]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {/* Keyed so an identical message (same tab finishing twice in a row)
          still remounts the node — live regions announce on DOM mutation,
          not on string inequality. */}
      <span key={announcement.seq}>{announcement.text}</span>
    </div>
  );
}

/** Background-stream state a tab surfaces as a marker. `null` = nothing to show
 *  (active tab, no record, or a user-aborted turn). */
export type TabStreamState = 'running' | 'done' | 'error';

export function tabStreamState(
  active: boolean,
  rec: StreamRecord | undefined,
): TabStreamState | null {
  if (active || !rec) return null;
  if (isStreamActive(rec)) return 'running';
  if (rec.phase === 'error') return 'error';
  if (rec.phase === 'done') return 'done';
  return null;
}

/** Exhaustive by construction: no `default` arm, so adding a `TabStreamState`
 *  member is a typecheck error here rather than a silent fall-through to the
 *  success mapping. Same shape `phaseLabelFor` used in the removed
 *  `StreamToasts`. */
export function streamAriaKey(state: TabStreamState): string {
  switch (state) {
    case 'running':
      return 'streamRunningAria';
    case 'done':
      return 'streamDoneAria';
    case 'error':
      return 'streamErrorAria';
  }
}

/**
 * A dot, never a status pill (§7.6).
 *
 * §8 forbids colour as the sole signal, and an `aria-label` does not satisfy
 * it — the distinction has to survive for a sighted colour-blind user who
 * never hovers. Each state therefore carries a distinct *shape*, and the pairs
 * stay distinguishable with both colour and motion removed:
 *
 *   running → hollow accent ring (+ pulse)   outline
 *   done    → solid accent disc              filled
 *   error   → hollow ring + `!` glyph        outline + glyph
 *
 * running vs done separates on fill, so it survives `prefers-reduced-motion`
 * killing the pulse (globals.css universal reset). error vs running separates
 * on the glyph. State colour stays text/edge-only — never a solid `--danger`
 * fill (house rule, cf. `chat/page.tsx:932`).
 */
export function streamDotClass(state: TabStreamState): string {
  const base =
    'ml-1 inline-flex size-3 shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none';
  switch (state) {
    case 'running':
      return `${base} ring-1 ring-[color:var(--accent)] animate-pulse`;
    case 'done':
      return `${base} bg-[color:var(--accent)]`;
    case 'error':
      return `${base} ring-1 ring-[color:var(--danger-edge)] text-[color:var(--danger)]`;
  }
}

/** The visible non-colour cue carried *inside* the marker. Only `error` needs
 *  a glyph; `running`/`done` are already separated by ring-vs-fill. */
export function streamDotGlyph(state: TabStreamState): string {
  return state === 'error' ? '!' : '';
}

interface TabProps {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  canClose: boolean;
  disabled: boolean;
}

function Tab({
  session,
  active,
  onSelect,
  onClose,
  onRename,
  canClose,
  disabled,
}: TabProps): React.ReactElement {
  const t = useTranslations('chatTabs');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  // In-context surfacing (issue #286): a background session's stream state
  // lives on its tab, not in a floating toast. The active tab shows nothing —
  // its stream is already visible inline. `aborted` gets no marker: the user
  // stopped it themselves, so there's nothing unread to flag.
  const streamState = tabStreamState(active, useStreamRecord(session.id));

  useEffect(() => {
    if (editing) {
      // Seed the rename draft from the current title when entering edit
      // mode; the focus/select below needs the input mounted first.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(session.title);
      // `select()` after a microtask so the input is actually mounted and focused.
      queueMicrotask(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, session.title]);

  const commit = (): void => {
    setEditing(false);
    if (draft.trim() !== session.title) onRename(draft);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setDraft(session.title);
    }
  };

  const onClickClose = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    if (disabled) return;
    onClose();
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onDoubleClick={() => {
        setEditing(true);
      }}
      className={[
        'group flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-1 transition',
        // §4.2 tabs: the active tab carries the lit accent underline.
        active
          ? 'lume-tab-active bg-[color:var(--bg-elevated)] font-semibold'
          : 'text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]',
      ].join(' ')}
      title={`${session.title}\n${t('tabTitleSuffix', { id: session.id })}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            e.stopPropagation();
          }}
          className="w-40 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-1 text-xs"
          maxLength={120}
        />
      ) : (
        <span className="max-w-[18ch] truncate">{session.title}</span>
      )}
      {streamState && !editing && (
        <>
          {/* The glyph is decorative — `role="tab"` takes its accessible name
              from content, so the state is contributed once by the sr-only
              span below. Setting aria-label *and* title to the same string
              made several screen readers speak the sentence twice. `title`
              stays as the sighted-user hover tooltip. */}
          <span
            aria-hidden
            title={t(streamAriaKey(streamState))}
            className={streamDotClass(streamState)}
          >
            {streamDotGlyph(streamState)}
          </span>
          <span className="sr-only">{t(streamAriaKey(streamState))}</span>
        </>
      )}
      {canClose && !editing && (
        // eslint-disable-next-line no-restricted-syntax -- icon-only chrome (× close glyph)
        <button
          type="button"
          onClick={onClickClose}
          disabled={disabled}
          className="ml-1 rounded px-1 text-[color:var(--fg-subtle)] opacity-0 transition group-hover:opacity-100 hover:bg-[color:var(--state-loading)] hover:text-[color:var(--fg)] disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={t('closeAriaLabel', { title: session.title })}
          title={disabled ? t('closeWhileBusyTitle') : t('closeTitle')}
        >
          ×
        </button>
      )}
    </div>
  );
}
