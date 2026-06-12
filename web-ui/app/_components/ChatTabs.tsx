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
      <button
        type="button"
        onClick={onCreate}
        className="ml-1 shrink-0 rounded border border-[color:var(--border)] px-2 py-1 font-medium text-[color:var(--fg)] transition hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-elevated)]"
        title={t('newChatTitle')}
      >
        + {t('newChat')}
      </button>
    </div>
  );
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
        active
          ? 'bg-[color:var(--bg-elevated)] font-semibold text-[color:var(--fg-strong)] ring-1 ring-[color:var(--border-strong)]'
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
      {canClose && !editing && (
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
