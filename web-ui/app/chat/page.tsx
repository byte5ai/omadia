'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { Eraser, GitBranch, Navigation, Network } from 'lucide-react';
import { ChatTabs } from '../_components/ChatTabs';
import { Button } from '../_components/ui/Button';
import { AgentPicker } from '../_components/AgentPicker';
import { AgentUnavailableBanner } from '../_components/AgentUnavailableBanner';
import { AgentUsagePills } from '../_components/chat/AgentUsagePills';
import { AutoPromotedBanner } from '../_components/chat/AutoPromotedBanner';
import { CaptureDisclosure } from '../_components/chat/CaptureDisclosure';
import { ConfirmDialog } from '../_components/ConfirmDialog';
import { NudgeCard, parseNudgeBlock } from '../_components/chat/NudgeCard';
import { PlanProgressCard } from '../_components/chat/PlanProgressCard';
import { RecalledContextCard } from '../_components/chat/RecalledContextCard';
import { PrivacyReceiptCard } from '../_components/chat/PrivacyReceiptCard';
import { SaveMemoryButton } from '../_components/chat/SaveMemoryButton';
import { Markdown } from '../_components/Markdown';
import { resetChatSession, steerActiveTurn } from '../_lib/api';
import {
  deriveTitle,
  newSessionId,
  type ChatSession,
  type DiagramAttachment,
  type OutgoingFileAttachment,
  type FollowUpOption,
  type Message,
  type NudgeEvent,
  type SubAgentEvent,
  type ToolEvent,
} from '../_lib/chatSessions';
import { useChatSessionsCtx } from '../_lib/chatSessionsContext';
import { useStreamStore } from '../_lib/streamStore';
import { ChoiceCard } from '../_components/ChoiceCard';
import { KgWalkPane } from '../_components/KgWalkPane';
import { PlanDagPane } from '../_components/PlanDagPane';
import type { KgWalkPayload, PlanSnapshot } from '../_lib/chatSessions';

/**
 * Dev-only KG-walk fixture. Rendered in the floating pane when the URL carries
 * `?kgmock=1`, so the pane can be verified visually before the backend emits
 * real `kg_graph` annotations. Never shown otherwise. Intentionally multi-hop
 * (and multi-root, with several same-kind nodes) so the hop-details list and
 * the label-on-hover de-noising are both exercisable.
 */
const MOCK_KG_WALK: KgWalkPayload = {
  rootIds: ['mk:1', 'mk:2'],
  nodes: [
    { id: 'mk:1', label: 'Urlaubsantrag-Policy', kind: 'MemorableKnowledge', score: 0.92 },
    { id: 'mk:2', label: 'Gleitzeit-Konto-Regel', kind: 'MemorableKnowledge', score: 0.81 },
    { id: 'turn:a', label: 'Turn · Urlaub 2024', kind: 'Turn' },
    { id: 'turn:b', label: 'Turn · Überstunden', kind: 'Turn' },
    { id: 'turn:c', label: 'Turn · Resturlaub-Übertrag', kind: 'Turn' },
    { id: 'ent:hr', label: 'HR-Abteilung', kind: 'Entity' },
    { id: 'ent:policy', label: 'Gleitzeit-Regel', kind: 'Entity' },
    { id: 'ent:contract', label: 'Arbeitsvertrag-Standard', kind: 'Entity' },
    { id: 'user:max', label: 'Max Mustermann', kind: 'User' },
    { id: 'user:eva', label: 'Eva Beispiel', kind: 'User' },
    { id: 'ins:1', label: 'Mitarbeiter bevorzugen flexible Modelle', kind: 'Insight' },
  ],
  edges: [
    { from: 'mk:1', to: 'turn:a', type: 'DERIVED_FROM', hop: 1 },
    { from: 'mk:1', to: 'ent:hr', type: 'MENTIONS', hop: 1 },
    { from: 'mk:2', to: 'ent:policy', type: 'DERIVED_FROM', hop: 1 },
    { from: 'mk:2', to: 'turn:b', type: 'MENTIONS', hop: 1 },
    { from: 'turn:a', to: 'user:max', type: 'INVOLVES', hop: 2 },
    { from: 'ent:hr', to: 'ent:policy', type: 'RELATES_TO', hop: 2 },
    { from: 'turn:b', to: 'user:eva', type: 'INVOLVES', hop: 2 },
    { from: 'ent:policy', to: 'ent:contract', type: 'GOVERNED_BY', hop: 2 },
    { from: 'ent:policy', to: 'turn:c', type: 'CITED_IN', hop: 3 },
    { from: 'ent:contract', to: 'ins:1', type: 'SUPPORTS', hop: 3 },
    { from: 'turn:c', to: 'user:max', type: 'INVOLVES', hop: 3 },
  ],
};

const EMPTY_SUBSCRIBE = (): (() => void) => () => undefined;

function useKgMockEnabled(): boolean {
  // useSyncExternalStore avoids a setState-in-effect: the client snapshot reads
  // the URL directly, the server snapshot is always false (no SSR mismatch
  // because the store never changes after mount).
  return useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () =>
      new URLSearchParams(window.location.search).get('kgmock') === '1',
    () => false,
  );
}

// Master on/off for the chat visualization panes (KG-walk on the right, Plan
// DAG on the left), persisted in localStorage so the operator's choice sticks
// across reloads. Both DEFAULT OFF: the panes stay off until the operator
// turns them on (stored '1'); they never auto-start. useSyncExternalStore
// keeps it SSR-safe (server
// snapshot mirrors the default) and updates in place without a setState-in-
// effect; we also listen to the cross-tab `storage` event plus a same-tab
// custom event so a pill flip in one place re-renders every reader.
const TOGGLE_PREF_EVENT = 'omadia:viz-pref';

function subscribeTogglePref(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(TOGGLE_PREF_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(TOGGLE_PREF_EVENT, onChange);
  };
}

/** Generic persisted boolean toggle keyed on a localStorage slot. The caller
 *  picks the default applied when the slot is unset; an explicit choice
 *  ('1' / '0') always wins and sticks across reloads. */
function usePersistedToggle(
  storageKey: string,
  defaultEnabled: boolean,
): readonly [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeTogglePref,
    () => {
      try {
        const stored = window.localStorage.getItem(storageKey);
        return stored === null ? defaultEnabled : stored === '1';
      } catch {
        return defaultEnabled;
      }
    },
    () => defaultEnabled,
  );
  const setEnabled = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* storage disabled (private mode) — toggle still applies this render */
      }
      window.dispatchEvent(new Event(TOGGLE_PREF_EVENT));
    },
    [storageKey],
  );
  return [enabled, setEnabled] as const;
}

function useKgWalkEnabled(): readonly [boolean, (next: boolean) => void] {
  return usePersistedToggle('omadia.kgWalkEnabled', false);
}

function usePlanDagEnabled(): readonly [boolean, (next: boolean) => void] {
  return usePersistedToggle('omadia.planDagEnabled', false);
}

export default function ChatPage(): React.ReactElement {
  const t = useTranslations('chat');
  const {
    sessions,
    activeId,
    activeSession,
    hydrating,
    createSession,
    deleteSession,
    renameSession,
    setActive,
    clearMessages,
    mutateActive,
  } = useChatSessionsCtx();
  const streamStore = useStreamStore();
  const sending = streamStore.isActive(activeId);
  const kgMockEnabled = useKgMockEnabled();
  const [kgWalkEnabled, setKgWalkEnabled] = useKgWalkEnabled();
  const [planDagEnabled, setPlanDagEnabled] = usePlanDagEnabled();

  // The KG-walk surfaced in the floating pane = the most recent assistant
  // message that carries one. Falls back to the dev mock when `?kgmock=1` and
  // no real walk has streamed in yet.
  const activeKgWalk = useMemo<KgWalkPayload | null>(() => {
    for (let i = activeSession.messages.length - 1; i >= 0; i -= 1) {
      const m = activeSession.messages[i];
      if (m?.role === 'assistant' && m.kgWalk) return m.kgWalk;
    }
    return kgMockEnabled ? MOCK_KG_WALK : null;
  }, [activeSession.messages, kgMockEnabled]);

  // The live plan surfaced in the left pane = the most recent assistant message
  // carrying a plan snapshot (re-emitted on every step change / replan).
  const activePlan = useMemo<PlanSnapshot | null>(() => {
    for (let i = activeSession.messages.length - 1; i >= 0; i -= 1) {
      const m = activeSession.messages[i];
      if (m?.role === 'assistant' && m.plan) return m.plan;
    }
    return null;
  }, [activeSession.messages]);

  const [input, setInput] = useState('');
  const [resetPending, setResetPending] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  /** Mid-turn steering — true while a `/chat/steer` request is in flight. */
  const [steerBusy, setSteerBusy] = useState(false);
  /** Transient composer notice after a steer attempt: 'sent' when it was
   *  buffered into the live turn, 'ended' when the turn had already finished
   *  (the typed text is kept so the user can resend it as a normal turn). */
  const [steerNotice, setSteerNotice] = useState<'sent' | 'ended' | null>(null);
  /** Phase A — selected Agent slug for the upcoming first turn.
   *  Ignored after the session pins (server snapshots on first turn). */
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest message in view as it streams. Smooth scrolling can't
  // keep pace with rapid token deltas — the animation restarts further
  // behind on every tick and never reaches the bottom, leaving the latest
  // content hidden under the input footer — so this jumps instantly.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSession.messages]);

  // Slice 4c — clear the auto-promoted-MK marker on a message after the
  // user Discards it. The manual save-as-memory button then comes back so
  // the user can re-save with their own classification.
  const clearAutoPromoted = useCallback(
    (messageId: string): void => {
      mutateActive((session) => {
        const nextMessages = session.messages.map((m) => {
          if (m.id !== messageId) return m;
          const { autoPromotedMkId: _drop, ...rest } = m;
          return rest;
        });
        return { ...session, messages: nextMessages, updatedAt: Date.now() };
      });
    },
    [mutateActive],
  );

  const send = useCallback(
    (overrideText?: string): void => {
      // Two entry points use this: the Senden button (reads `input`) and the
      // Smart-Card option buttons (pass the chosen label via overrideText).
      const trimmed = (overrideText ?? input).trim();
      if (!trimmed || sending || hydrating) return;

      const targetSessionId = activeId;
      const userMsg: Message = {
        id: newSessionId(),
        role: 'user',
        content: trimmed,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      const pendingId = newSessionId();
      const pending: Message = {
        id: pendingId,
        role: 'assistant',
        content: '',
        tools: [],
        startedAt: Date.now(),
        streaming: true,
      };

      mutateActive((session) => {
        if (session.id !== targetSessionId) return session;
        const isFirst = session.messages.length === 0;
        // Strip pendingUserChoice AND followUpOptions from older assistant
        // messages so the button rows disappear as soon as the user commits
        // to a choice or types a fresh message.
        const cleanedMessages = session.messages.map((m) => {
          if (!m.pendingUserChoice && !m.followUpOptions) return m;
          const {
            pendingUserChoice: _dropChoice,
            followUpOptions: _dropFollowUps,
            ...rest
          } = m;
          return rest;
        });
        return {
          ...session,
          title: isFirst ? deriveTitle(trimmed) : session.title,
          messages: [...cleanedMessages, userMsg, pending],
          updatedAt: Date.now(),
        };
      });
      if (overrideText === undefined) setInput('');

      // Hand the stream off to <StreamRunner /> via the store. The runner
      // owns the fetch + NDJSON-parse loop and writes deltas back into
      // ChatSessions via context, so a menu-switch or ChatTabs switch no
      // longer kills the stream.
      // Phase A — only the FIRST turn ships agentSlug; subsequent turns
      // use the session-pinned snapshot on the server side.
      const isFirstTurn = activeSession.messages.length === 0;
      streamStore.startTurn({
        sessionId: targetSessionId,
        pendingMessageId: pendingId,
        message: trimmed,
        ...(isFirstTurn && selectedAgentSlug
          ? { agentSlug: selectedAgentSlug }
          : {}),
      });
      inputRef.current?.focus();
    },
    [
      input,
      sending,
      hydrating,
      activeId,
      mutateActive,
      streamStore,
      activeSession.messages.length,
      selectedAgentSlug,
    ],
  );

  const abort = (): void => {
    streamStore.abort(activeId);
  };

  /**
   * Mid-turn steering — inject the composer text into the turn that's currently
   * streaming, instead of starting a new one. The orchestrator folds it in at
   * its next iteration boundary. If the turn ended in the meantime we keep the
   * text so the user can resend it normally once the composer flips to Send.
   */
  const steer = useCallback(async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || !sending || steerBusy) return;
    setSteerBusy(true);
    setSteerNotice(null);
    try {
      const outcome = await steerActiveTurn(activeId, trimmed);
      if (outcome === 'applied') {
        setInput('');
        setSteerNotice('sent');
      } else {
        setSteerNotice('ended');
      }
    } catch (err) {
      console.warn(
        '[chat-steer] steer failed:',
        err instanceof Error ? err.message : err,
      );
      setSteerNotice('ended');
    } finally {
      setSteerBusy(false);
      inputRef.current?.focus();
    }
  }, [input, sending, steerBusy, activeId]);

  // Auto-dismiss the steer notice so it doesn't linger across turns.
  useEffect(() => {
    if (!steerNotice) return;
    const timer = setTimeout(() => {
      setSteerNotice(null);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [steerNotice]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (sending) {
        void steer();
      } else {
        send();
      }
    }
  };

  const requestReset = (): void => {
    if (resetPending) return;
    if (activeSession.messages.length === 0) return;
    setConfirmResetOpen(true);
  };

  const performReset = useCallback(async (): Promise<void> => {
    setConfirmResetOpen(false);
    setResetPending(true);
    try {
      // Abort any in-flight stream for this session first — otherwise the
      // runner would happily keep writing deltas into a freshly cleared
      // message list.
      streamStore.abort(activeId);
      // Backend rotates the conversation pointer so the agent starts a new
      // turn-chain. KG / Memory are NOT touched. If the backend isn't
      // reachable we still clear locally — the user wanted a fresh slate.
      try {
        await resetChatSession(activeId);
      } catch (err) {
        console.warn(
          '[chat-reset] backend reset failed, clearing locally only:',
          err instanceof Error ? err.message : err,
        );
      }
      await clearMessages(activeId);
    } finally {
      setResetPending(false);
      inputRef.current?.focus();
    }
  }, [activeId, clearMessages, streamStore]);

  // Cmd/Ctrl+Shift+K resets the active chat (with confirm). Standard
  // ChatGPT/Claude.ai shortcut so muscle memory carries over.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const isModK =
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === 'k' || e.key === 'K');
      if (!isModK) return;
      e.preventDefault();
      requestReset();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
    // requestReset is a stable closure over component state but eslint can't
    // prove it; we depend on activeSession.messages.length implicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession.messages.length, resetPending]);

  const handleClose = (id: string): void => {
    void deleteSession(id);
  };

  const canReset =
    !hydrating && !resetPending && activeSession.messages.length > 0;

  return (
    <main className="flex h-full flex-col">
      <ChatTabs
        sessions={sessions}
        activeId={activeId}
        onSelect={setActive}
        onCreate={createSession}
        onClose={handleClose}
        onRename={(id, title) => {
          void renameSession(id, title);
        }}
        disabled={sending}
      />

      <div className="border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)]/75 px-6 py-2 text-xs">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {/* Row 1 — orchestrator picker. The stream-path + session-scope
              debug labels were removed 2026-06-26 (noise). The picker self-
              hides when there is only one orchestrator (nothing to choose). */}
          <div className="flex flex-wrap items-center gap-3 text-[color:var(--fg-muted)] empty:hidden">
            {/* Phase A — Orchestrator picker. Read-only pinned label after the
                first turn; dropdown before it. Renders null unless there is
                more than one orchestrator. */}
            <AgentPicker
              pinnedSlug={activeSession.snapshot?.agentSlug}
              selectedSlug={selectedAgentSlug}
              onSelect={setSelectedAgentSlug}
            />
          </div>

          {/* Row 2 — Visualization toggles. Both pills live here together (kept
              out of Row 1 so they don't wrap awkwardly under the agent picker).
              KG-walk (indigo) auto-opens the right pane on KG access; Plan (sky)
              auto-opens the left pane on plan fetch/extend. Both default ON. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={kgWalkEnabled}
              onClick={() => setKgWalkEnabled(!kgWalkEnabled)}
              title={t('kgWalk.toggleLabel')}
              className={[
                'inline-flex select-none items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium transition',
                kgWalkEnabled
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]'
                  : 'border-[color:var(--border)] bg-transparent text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-muted)]',
              ].join(' ')}
            >
              <Network size={12} aria-hidden />
              {t('kgWalk.toggleLabel')}
              <span
                aria-hidden
                className={[
                  'inline-block h-1.5 w-1.5 rounded-full',
                  kgWalkEnabled
                    ? 'bg-[color:var(--accent)]/100'
                    : 'bg-[color:var(--fg-subtle)]',
                ].join(' ')}
              />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={planDagEnabled}
              onClick={() => setPlanDagEnabled(!planDagEnabled)}
              title={t('planDag.toggleLabel')}
              className={[
                'inline-flex select-none items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium transition',
                planDagEnabled
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]'
                  : 'border-[color:var(--border)] bg-transparent text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-muted)]',
              ].join(' ')}
            >
              <GitBranch size={12} aria-hidden />
              {t('planDag.toggleLabel')}
              <span
                aria-hidden
                className={[
                  'inline-block h-1.5 w-1.5 rounded-full',
                  planDagEnabled
                    ? 'bg-[color:var(--accent)]/100'
                    : 'bg-[color:var(--fg-subtle)]',
                ].join(' ')}
              />
            </button>
          </div>

          {/* Row 3 — Agent-Usage-Pills (only when anything was invoked) */}
          <AgentUsagePills session={activeSession} />
        </div>
      </div>

      {/* Phase A / TA08 — agent_unavailable recovery banner. Mounted
          when the last stream finished with HTTP 503; clears on
          re-snapshot or session delete. */}
      {(() => {
        const rec = streamStore.get(activeId);
        if (!rec?.agentUnavailableSlug) return null;
        return (
          <AgentUnavailableBanner
            sessionId={activeId}
            unavailableSlug={rec.agentUnavailableSlug}
            onRecovered={() => {
              streamStore.patch(activeId, { agentUnavailableSlug: undefined });
              // Drop the pinned snapshot in the local session so the
              // header picker becomes available again for the next turn.
              mutateActive((s) => {
                if (s.id !== activeId) return s;
                const { snapshot: _drop, ...rest } = s;
                return rest;
              });
            }}
            onDeleted={() => {
              streamStore.patch(activeId, { agentUnavailableSlug: undefined });
              void clearMessages(activeId);
            }}
          />
        );
      })()}

      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-6 py-6"
          aria-live="polite"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {activeSession.messages.length === 0 && (
              <EmptyState hydrating={hydrating} session={activeSession} />
            )}
            {activeSession.messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                disabled={sending || hydrating}
                onChoose={(value) => {
                  send(value);
                }}
                onDiscardAutoPromoted={clearAutoPromoted}
              />
            ))}
          </div>
        </div>
      </div>

      {/* KG-walk — togglable floating pane (launcher chip → flying window) for
          the most recent turn's graph walk. Chat stays full width. Gated by the
          header toggle; `?kgmock=1` force-enables it for dev preview. */}
      <KgWalkPane walk={kgWalkEnabled || kgMockEnabled ? activeKgWalk : null} />

      {/* Plan-DAG — left-anchored sibling pane for the live plan of the most
          recent turn. Gated by its own header toggle. */}
      <PlanDagPane plan={planDagEnabled ? activePlan : null} />

      <footer className="border-t border-[color:var(--border)] bg-[color:var(--bg-elevated)]/85 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {/* Mid-turn steering hint / feedback — only while a turn streams. */}
          {sending && (
            <div className="flex items-center gap-2 text-[11px]">
              <Navigation size={11} aria-hidden className="text-[color:var(--warning)]" />
              {steerNotice === 'sent' ? (
                <span className="text-[color:var(--warning)]">
                  {t('steerNoticeSent')}
                </span>
              ) : steerNotice === 'ended' ? (
                <span className="text-[color:var(--fg-muted)]">
                  {t('steerNoticeEnded')}
                </span>
              ) : (
                <span className="text-[color:var(--fg-muted)]">
                  {t('steerHint')}
                </span>
              )}
            </div>
          )}
          {/* §5.3 Spotlight: the composer is the stage — radial accent glow
              behind it, three-stop showcase glow on the focused input. */}
          <div className="lume-spotlight-stage flex items-end gap-2">
            <button
              type="button"
              onClick={requestReset}
              disabled={!canReset}
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-2 text-[color:var(--fg-muted)] transition hover:border-[color:var(--border-strong)] hover:text-[color:var(--fg)] disabled:cursor-not-allowed disabled:opacity-30"
              title={t('composerResetTitle')}
              aria-label={t('composerResetAriaLabel')}
            >
              <Eraser size={16} aria-hidden />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder={sending ? t('steerPlaceholder') : t('placeholder')}
              className="flex-1 resize-none rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-3 py-2 text-sm shadow-sm focus:border-[color:var(--border-strong)] focus:outline-none"
              disabled={hydrating}
            />
            {sending ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void steer();
                  }}
                  disabled={input.trim().length === 0 || steerBusy || hydrating}
                  title={t('steerButtonTitle')}
                  className="flex items-center gap-2 rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 px-4 py-2 text-sm font-medium text-[color:var(--warning)] transition hover:bg-[color:var(--warning)]/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Navigation size={14} aria-hidden />
                  {t('steerButton')}
                </button>
                <Button variant="danger" onClick={abort}>
                  {t('stopButton')}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => {
                  send();
                }}
                disabled={input.trim().length === 0 || hydrating}
              >
                {t('sendButton')}
              </Button>
            )}
          </div>
        </div>
      </footer>

      <ConfirmDialog
        open={confirmResetOpen}
        title={t('resetConfirmTitle')}
        body={t('resetConfirmBody')}
        confirmLabel={t('resetConfirmAction')}
        cancelLabel={t('resetCancel')}
        tone="danger"
        onCancel={() => {
          setConfirmResetOpen(false);
        }}
        onConfirm={() => {
          void performReset();
        }}
      />
    </main>
  );
}

function EmptyState({
  hydrating,
  session,
}: {
  hydrating: boolean;
  session: ChatSession;
}): React.ReactElement {
  const t = useTranslations('chat');
  if (hydrating) {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--border)] p-8 text-center text-sm text-[color:var(--fg-subtle)]">
        {t('sessionsLoading')}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-[color:var(--border)] p-8 text-center text-sm text-[color:var(--fg-muted)]">
      <div className="font-medium">{session.title}</div>
      <div className="mt-1">{t('emptyStatePrompt')}</div>
      <div className="mt-2 text-xs text-[color:var(--fg-subtle)]">
        {t('emptyStateShortcut')}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  disabled,
  onChoose,
  onDiscardAutoPromoted,
}: {
  message: Message;
  disabled: boolean;
  onChoose: (value: string) => void;
  /** Slice 4c — called when the user successfully Discards an
   *  auto-promoted MK so the parent can clear `autoPromotedMkId` on
   *  this message and the manual save-as-memory button comes back. */
  onDiscardAutoPromoted: (messageId: string) => void;
}): React.ReactElement {
  const t = useTranslations('chat');
  const isUser = message.role === 'user';
  const elapsed =
    message.finishedAt !== undefined
      ? ((message.finishedAt - message.startedAt) / 1000).toFixed(1)
      : null;
  // Show the Theme E0+E1 liveness row whenever the turn is in flight
  // (`streaming`) or a tool call is still pending. Read-only on completed
  // messages — even if persisted state happens to carry a stale liveness
  // snapshot, it must not animate.
  const hasPendingTool = (message.tools ?? []).some(
    (t) => t.output === undefined,
  );
  const showLiveness = !isUser && (message.streaming === true || hasPendingTool);
  const liveNow = useClock(showLiveness ? 1000 : null);
  const liveElapsedSec = showLiveness
    ? Math.max(0, Math.round((liveNow - message.startedAt) / 1000))
    : null;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[85%] rounded-lg px-4 py-3',
          // §6.1: agent content condenses into existence; user bubbles are
          // the user's own action and appear instantly.
          isUser ? '' : 'lume-condense',
          isUser
            ? 'bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
            : message.error
              ? 'bg-[color:var(--danger)]/8 text-[color:var(--danger)] ring-1 ring-[color:var(--danger-edge)]'
              : 'bg-[color:var(--bg-elevated)] text-[color:var(--fg-strong)] ring-1 ring-[color:var(--border)]',
        ].join(' ')}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm">{message.content}</div>
        ) : (
          <>
            {message.routing && <TriageBadge routing={message.routing} />}
            {message.persona && <PersonaBadge persona={message.persona} />}
            {message.recalledContext && (
              <RecalledContextCard recalled={message.recalledContext} />
            )}
            {message.plan && (
              <PlanProgressCard
                plan={message.plan}
                streaming={message.streaming === true}
              />
            )}
            {(message.tools?.length ?? 0) > 0 && (
              <ToolTrace tools={message.tools ?? []} />
            )}
            {(message.nudges?.length ?? 0) > 0 && (
              <NudgeList nudges={message.nudges ?? []} />
            )}
            {(message.steers?.length ?? 0) > 0 && (
              <SteerList steers={message.steers ?? []} />
            )}
            {message.content.length > 0 ? (
              /* §2.7: agent narration renders in the prose register
                 (Source Serif 4); headings/tables/code stay structural. */
              <div className="lume-prose">
                <Markdown
                  source={message.content}
                  highlightTerms={message.maskedValues}
                />
              </div>
            ) : message.streaming ? (
              <StreamingDots />
            ) : null}
            {showLiveness && (
              <LivenessRow
                liveness={message.liveness}
                tokensPerSec={message.tokensPerSec}
                lastUsage={message.lastUsage}
                elapsedSec={liveElapsedSec ?? 0}
                showInlineDots={message.content.length > 0}
              />
            )}
            {message.pendingUserChoice && (
              <ChoiceCard
                choice={message.pendingUserChoice}
                disabled={disabled}
                onChoose={onChoose}
              />
            )}
            {message.attachments && message.attachments.length > 0 && (
              <AttachmentGrid attachments={message.attachments} />
            )}
            {message.fileAttachments && message.fileAttachments.length > 0 && (
              <FileAttachmentList files={message.fileAttachments} />
            )}
            {message.followUpOptions && message.followUpOptions.length > 0 && (
              <FollowUpButtons
                options={message.followUpOptions}
                disabled={disabled}
                onChoose={onChoose}
              />
            )}
            {message.captureDisclosure && (
              <CaptureDisclosure disclosure={message.captureDisclosure} />
            )}
            {message.privacyReceipt && (
              <PrivacyReceiptCard receipt={message.privacyReceipt} />
            )}
          </>
        )}
        {!isUser &&
          (message.telemetry || elapsed || message.turnId !== undefined) && (
            <div className="mt-2 flex flex-wrap items-center border-t border-current/10 pt-2 text-[11px] text-[color:var(--fg-muted)]">
              {message.telemetry && (
                <span>
                  tools={message.telemetry.tool_calls} · iterations=
                  {message.telemetry.iterations}
                </span>
              )}
              {message.model && (
                <span
                  className="ml-3 rounded bg-current/10 px-2 py-0.5 font-medium"
                  title={message.model}
                >
                  {shortModelName(message.model)}
                </span>
              )}
              {elapsed !== null && <span className="ml-3">⏱ {elapsed}s</span>}
              {message.streaming && (
                <span className="ml-3">{t('streamingSuffix')}</span>
              )}
              {!message.streaming &&
                !message.error &&
                message.turnId !== undefined &&
                (message.autoPromotedMkId !== undefined ? (
                  <AutoPromotedBanner
                    mkId={message.autoPromotedMkId}
                    kind={message.palaiaExcerpt?.suggestedKind ?? 'insight'}
                    onDiscarded={() => onDiscardAutoPromoted(message.id)}
                  />
                ) : (
                  <SaveMemoryButton
                    turnId={message.turnId}
                    messageContent={message.content}
                    {...(message.palaiaExcerpt
                      ? { palaiaExcerpt: message.palaiaExcerpt }
                      : {})}
                  />
                ))}
            </div>
          )}
      </div>
    </div>
  );
}

function ToolTrace({ tools }: { tools: ToolEvent[] }): React.ReactElement {
  const t = useTranslations('chat');
  return (
    <details className="mb-2 rounded bg-[color:var(--bg-soft)] text-xs">
      <summary className="cursor-pointer px-2 py-1 font-medium text-[color:var(--fg-muted)] select-none">
        {t('toolTraceHeading', { count: tools.length })}
      </summary>
      <div className="flex flex-col gap-1 px-2 pb-2">
        {tools.map((t) => (
          <ToolRow key={t.id} tool={t} />
        ))}
      </div>
    </details>
  );
}

function ToolRow({ tool }: { tool: ToolEvent }): React.ReactElement {
  const t = useTranslations('chat');
  const pending = tool.output === undefined;
  // Tick every second while pending so the elapsed timer updates smoothly
  // without waiting for backend heartbeats (which land every 5s).
  const now = useClock(pending ? 1000 : null);
  const status = pending ? '…' : tool.isError ? '✗' : '✓';
  const isKG = tool.name === 'query_knowledge_graph';
  const kgSummary = isKG ? summarizeKnowledgeGraphInput(tool.input) : null;
  const inputPreview = kgSummary ?? previewInput(tool.input);
  const icon = isKG ? '🔎' : null;

  const elapsedLabel = (() => {
    if (tool.durationMs !== undefined) return formatMs(tool.durationMs);
    if (tool.startedAt !== undefined) return formatMs(now - tool.startedAt);
    if (tool.liveElapsedMs !== undefined) return formatMs(tool.liveElapsedMs);
    return null;
  })();
  const elapsedMs =
    tool.durationMs ??
    (tool.startedAt !== undefined ? now - tool.startedAt : tool.liveElapsedMs ?? 0);
  const elapsedColor = pending
    ? elapsedMs > 60_000
      ? 'text-[color:var(--warning)]'
      : elapsedMs > 30_000
        ? 'text-[color:var(--warning)]'
        : 'text-[color:var(--fg-muted)]'
    : 'text-[color:var(--fg-muted)]';

  const subEvents = tool.subEvents ?? [];

  return (
    <details
      className={[
        'rounded border text-[11px]',
        pending
          ? 'border-[color:var(--border)]'
          : tool.isError
            ? 'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8'
            : isKG
              ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10'
              : 'border-[color:var(--border)] bg-[color:var(--bg-elevated)]',
      ].join(' ')}
      open={pending}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 font-mono select-none">
        <span>{status}</span>
        {icon && <span>{icon}</span>}
        <span className="font-semibold">{tool.name}</span>
        {inputPreview && (
          <span
            className="max-w-[40ch] truncate font-normal text-[color:var(--fg-muted)]"
            title={inputPreview}
          >
            · {inputPreview}
          </span>
        )}
        {subEvents.length > 0 && (
          <span className="rounded bg-[color:var(--state-loading)] px-1 font-normal text-[color:var(--fg-muted)]">
            {t('subCallCount', {
              count: subEvents.filter((e) => e.kind === 'tool_use').length,
            })}
          </span>
        )}
        {elapsedLabel !== null && (
          <span className={['ml-auto', elapsedColor].join(' ')}>
            {elapsedLabel}
          </span>
        )}
      </summary>
      <div className="border-t border-[color:var(--border)] px-2 py-1">
        <div className="text-[color:var(--fg-muted)]">{t('inputLabel')}</div>
        <pre className="overflow-x-auto font-mono">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
        {subEvents.length > 0 && <SubTrace events={subEvents} now={now} />}
        {tool.output !== undefined && (
          <ToolOutputWithNudge output={tool.output} />
        )}
      </div>
    </details>
  );
}

/**
 * OB-77 (Palaia Phase 8 Slice 4) — strips any inline `<nudge>` block
 * from the tool_result.output before rendering. The actual NudgeCard
 * rendering happens at the message level via `<NudgeList>`, which
 * collects per-turn nudges from dedicated stream events. The pipeline
 * still embeds the XML block in the tool_result content (so the agent
 * sees it on its next API call) — this strip keeps the dev UI's `<pre>`
 * output clean.
 */
/**
 * Shorten an Anthropic model id for the footer badge: `claude-opus-4-8` →
 * `opus-4-8`, `claude-3-5-haiku-20241022` → `haiku`. Falls back to the raw id.
 */
function shortModelName(model: string): string {
  const stripped = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const family = stripped.match(/(opus|sonnet|haiku)[\w.-]*/i);
  return family ? family[0] : stripped;
}

/**
 * Inline triage chip — rendered at the top of an assistant turn as soon as the
 * Haiku classifier resolves (the `turn_routing` event). Shows the verdict
 * (einfach/komplex/Fallback) and which model the turn was routed to.
 */
function TriageBadge({
  routing,
}: {
  routing: {
    bucket: 'simple' | 'complex' | 'fallback';
    classifierModel: string;
    model: string;
  };
}): React.ReactElement {
  const verdict: Record<typeof routing.bucket, { label: string; cls: string }> = {
    simple: {
      label: 'einfach',
      cls: 'bg-[color:var(--success)]/10 text-[color:var(--success)] ring-[color:var(--success)]',
    },
    complex: {
      label: 'komplex',
      cls: 'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-[color:var(--accent)]',
    },
    fallback: {
      label: 'Fallback',
      cls: 'bg-[color:var(--warning)]/10 text-[color:var(--warning)] ring-[color:var(--warning)]',
    },
  };
  const v = verdict[routing.bucket];
  return (
    <div
      className="mb-2 inline-flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--fg-muted)]"
      title={`Triage-Klassifizierer: ${routing.classifierModel} → ${routing.bucket} → ${routing.model}`}
    >
      <span className="font-medium uppercase tracking-[0.12em]">Triage</span>
      <span className="text-[color:var(--fg-subtle)]">
        {shortModelName(routing.classifierModel)} →
      </span>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium uppercase tracking-[0.08em] ring-1 ${v.cls}`}
      >
        {v.label}
      </span>
      <span className="text-[color:var(--fg-subtle)]">→</span>
      <span className="rounded bg-current/10 px-2 py-0.5 font-medium">
        {shortModelName(routing.model)}
      </span>
    </div>
  );
}

/**
 * Wave 8 — inline persona chip — rendered at the top of an assistant turn as
 * soon as the direct-answer persona classifier resolves (the `turn_persona`
 * event). Shows which persona skill answered this turn, or that the Agent
 * kept its default identity.
 */
function PersonaBadge({
  persona,
}: {
  persona: {
    bucket: 'matched' | 'none' | 'fallback';
    classifierModel: string;
    skillId: string | null;
    skillName: string | null;
  };
}): React.ReactElement {
  const t = useTranslations('chat');
  const isMatched = persona.bucket === 'matched' && persona.skillName;
  const isFallback = persona.bucket === 'fallback';
  const cls = isMatched
    ? 'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-[color:var(--accent)]'
    : isFallback
      ? 'bg-[color:var(--warning)]/10 text-[color:var(--warning)] ring-[color:var(--warning)]'
      : 'bg-[color:var(--fg-subtle)]/10 text-[color:var(--fg-subtle)] ring-[color:var(--fg-subtle)]';
  const label = isMatched
    ? t('persona.matched', { name: persona.skillName ?? '' })
    : isFallback
      ? t('persona.fallback')
      : t('persona.none');
  return (
    <div
      className="mb-2 inline-flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--fg-muted)]"
      title={`${t('persona.title')}: ${shortModelName(persona.classifierModel)} → ${persona.bucket}`}
    >
      <span className="font-medium uppercase tracking-[0.12em]">{t('persona.title')}</span>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ring-1 ${cls}`}
      >
        {label}
      </span>
    </div>
  );
}

function ToolOutputWithNudge({ output }: { output: string }): React.ReactElement {
  const t = useTranslations('chat');
  const { cleaned } = parseNudgeBlock(output);
  return (
    <>
      <div className="mt-2 text-[color:var(--fg-muted)]">{t('outputLabel')}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono">
        {cleaned}
      </pre>
    </>
  );
}

/**
 * OB-77 — consolidated nudge list rendered between the tool trace and
 * the assistant answer. Multiple nudges stack vertically; each renders
 * a `<NudgeCard>` with its hint + optional CTA button.
 */
function NudgeList({ nudges }: { nudges: NudgeEvent[] }): React.ReactElement {
  return (
    <div className="mt-2 space-y-2">
      {nudges.map((n) => (
        <NudgeCard
          key={`${n.id}:${n.nudgeId}`}
          nudge={{
            id: n.nudgeId,
            text: n.text,
            ...(n.cta
              ? {
                  cta: {
                    label: n.cta.label,
                    toolName: n.cta.toolName,
                    args: n.cta.arguments,
                  },
                }
              : {}),
          }}
          onCtaClick={(cta) => {
            console.warn(
              `[nudge] CTA invoked: ${cta.toolName}(${JSON.stringify(cta.args)})`,
            );
          }}
          onSuppressClick={(id) => {
            console.warn(`[nudge] suppress requested for ${id}`);
          }}
        />
      ))}
    </div>
  );
}

/**
 * Mid-turn steering trace — renders each user message that was injected via
 * `/chat/steer` while this turn was streaming, so the reader can see where live
 * input was folded into the agent's reasoning. Amber to match the composer's
 * steer affordance.
 */
function SteerList({ steers }: { steers: string[] }): React.ReactElement {
  const t = useTranslations('chat');
  return (
    <div className="mt-2 space-y-1">
      {steers.map((text, i) => (
        <div
          key={`${String(i)}:${text.slice(0, 24)}`}
          className="flex items-start gap-2 rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 px-2 py-1 text-[11px] text-[color:var(--warning)]"
        >
          <Navigation size={11} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">{t('steerTraceLabel')}</span>{' '}
            {text}
          </span>
        </div>
      ))}
    </div>
  );
}

function SubTrace({
  events,
  now,
}: {
  events: SubAgentEvent[];
  now: number;
}): React.ReactElement {
  const t = useTranslations('chat');
  // Pair each tool_use with its matching tool_result so the UI renders one
  // nested row per sub-call with live duration. Iterations are interleaved.
  // Unmatched tool_uses (still in-flight) show a live timer.
  const rows: Array<
    | { kind: 'iteration'; at: number; iteration: number }
    | {
        kind: 'call';
        at: number;
        id: string;
        name?: string;
        input?: unknown;
        result?: { output: string; durationMs: number; isError: boolean };
      }
  > = [];
  const pendingByUseId = new Map<string, number>();

  for (const e of events) {
    if (e.kind === 'iteration') {
      rows.push({
        kind: 'iteration',
        at: e.at,
        iteration: e.iteration ?? 0,
      });
    } else if (e.kind === 'tool_use') {
      const id = e.id ?? `anon-${String(e.at)}`;
      const idx = rows.push({
        kind: 'call',
        at: e.at,
        id,
        name: e.name,
        input: e.input,
      });
      pendingByUseId.set(id, idx - 1);
    } else if (e.kind === 'tool_result') {
      const id = e.id ?? '';
      const idx = pendingByUseId.get(id);
      if (idx !== undefined) {
        const row = rows[idx];
        if (row && row.kind === 'call') {
          row.result = {
            output: e.output ?? '',
            durationMs: e.durationMs ?? 0,
            isError: e.isError ?? false,
          };
        }
        pendingByUseId.delete(id);
      }
    }
  }

  return (
    <div className="mt-2 space-y-1 border-l-2 border-[color:var(--border)] pl-2">
      <div className="text-[color:var(--fg-muted)]">{t('subAgentTrace')}</div>
      {rows.map((row, idx) => {
        if (row.kind === 'iteration') {
          return (
            <div
              key={`iter-${String(idx)}`}
              className="text-[10px] text-[color:var(--fg-muted)]"
            >
              {t('iterationLabel', { n: row.iteration })}
            </div>
          );
        }
        const pending = !row.result;
        const elapsedMs = row.result
          ? row.result.durationMs
          : now - row.at;
        return (
          <details
            key={`call-${row.id}-${String(idx)}`}
            className={[
              'rounded border text-[10px]',
              pending
                ? 'border-[color:var(--border)]'
                : row.result?.isError
                  ? 'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8'
                  : 'border-[color:var(--border)] bg-[color:var(--bg-elevated)]/75',
            ].join(' ')}
          >
            <summary className="flex cursor-pointer items-center gap-2 px-2 py-0.5 font-mono select-none">
              <span>
                {pending ? '…' : row.result?.isError ? '✗' : '✓'}
              </span>
              <span className="font-semibold">{row.name ?? '?'}</span>
              {previewInput(row.input) && (
                <span
                  className="max-w-[36ch] truncate font-normal text-[color:var(--fg-muted)]"
                  title={previewInput(row.input) ?? ''}
                >
                  · {previewInput(row.input)}
                </span>
              )}
              <span className="ml-auto text-[color:var(--fg-muted)]">
                {formatMs(elapsedMs)}
              </span>
            </summary>
            <div className="border-t border-[color:var(--border)] px-2 py-1">
              <pre className="overflow-x-auto font-mono">
                {JSON.stringify(row.input, null, 2)}
              </pre>
              {row.result && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">
                  {row.result.output}
                </pre>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/**
 * Forces re-render at `intervalMs` cadence for live-updating UI (elapsed
 * timers). Pass `null` to disable and save render cycles once the work is done.
 */
function useClock(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Best-effort one-line preview of a tool input — prefers a `question` field
 * (our domain tools shape), falls back to the first string value, then to
 * truncated JSON. Returns null for empty/null inputs so the caller can skip
 * rendering entirely.
 */
function previewInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return truncate(input, 80);
  if (typeof input !== 'object') return truncate(String(input), 80);
  const record = input as Record<string, unknown>;
  const question = record['question'];
  if (typeof question === 'string' && question.length > 0) {
    return truncate(question, 80);
  }
  for (const v of Object.values(record)) {
    if (typeof v === 'string' && v.length > 0) return truncate(v, 80);
  }
  try {
    return truncate(JSON.stringify(record), 80);
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

/**
 * Renders a query_knowledge_graph tool invocation as a one-line hint, e.g.
 *   find_entity: name~"Müller" model=hr.employee
 *   session_summary: scope=teams-xyz
 * Returns null for unrecognised shapes so the caller falls back to previewInput.
 */
function summarizeKnowledgeGraphInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const query = typeof rec['query'] === 'string' ? rec['query'] : null;
  if (!query) return null;
  const bits: string[] = [];
  if (typeof rec['name_contains'] === 'string') {
    bits.push(`name~"${truncate(rec['name_contains'], 30)}"`);
  }
  if (typeof rec['model'] === 'string') bits.push(`model=${rec['model']}`);
  if (typeof rec['scope'] === 'string') {
    bits.push(`scope=${truncate(rec['scope'], 24)}`);
  }
  if (typeof rec['limit'] === 'number') bits.push(`limit=${rec['limit']}`);
  return bits.length > 0 ? `${query}: ${bits.join(' ')}` : query;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds - mins * 60);
  return `${String(mins)}m${String(secs).padStart(2, '0')}s`;
}

/**
 * Renders diagram attachments (today only `render_diagram` PNGs) under the
 * markdown answer. Each image is wrapped in a link so clicking opens the full
 * resolution in a new tab — mirrors the Teams Adaptive-Card `selectAction`.
 *
 * Note on expiry: signed URLs have a 15-min TTL (middleware default). Old
 * messages loaded from persistence will show broken images after that —
 * acceptable in dev. A future refinement could call a refresh endpoint.
 */
function AttachmentGrid({
  attachments,
}: {
  attachments: DiagramAttachment[];
}): React.ReactElement {
  const t = useTranslations('chat');
  return (
    <div className="mt-3 flex flex-col gap-2">
      {attachments.map((att, idx) => (
        <a
          key={`${att.url}-${String(idx)}`}
          href={att.url}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-2 transition hover:border-[color:var(--border-strong)]"
          title={t('attachmentTitle', {
            kind: att.diagramKind,
            cachedSuffix: att.cacheHit ? t('attachmentCachedSuffix') : '',
          })}
        >
          {/* Plain <img>: Next's Image component would complain about the
              middleware origin without config, and these PNGs are cheap. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={att.url}
            alt={att.altText}
            className="mx-auto max-h-[500px] w-auto"
          />
          <div className="mt-1 text-[10px] text-[color:var(--fg-muted)]">
            {att.diagramKind}
            {att.cacheHit && ' · cached'}
            {' · '}
            <span className="font-mono">{att.altText}</span>
          </div>
        </a>
      ))}
    </div>
  );
}

/**
 * Renders downloadable file attachments (e.g. `create_xlsx` / `create_docx`)
 * as a list of download links. Like diagrams, the signed URL carries a TTL —
 * old persisted messages may show expired links after it lapses (acceptable
 * in dev). Labels are extension-derived so no i18n keys are needed.
 */
function FileAttachmentList({
  files,
}: {
  files: OutgoingFileAttachment[];
}): React.ReactElement {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {files.map((file, idx) => (
        <a
          key={`${file.url}-${String(idx)}`}
          href={file.url}
          download={file.altText}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-3 transition hover:border-[color:var(--border-strong)]"
        >
          <span aria-hidden className="text-xl">
            {fileGlyph(file)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{file.altText}</span>
            <span className="text-[10px] uppercase text-[color:var(--fg-muted)]">
              {fileExt(file.altText)}
              {file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ''}
            </span>
          </span>
          <span className="ml-auto text-sm text-[color:var(--fg-subtle)]" aria-hidden>
            ↓
          </span>
        </a>
      ))}
    </div>
  );
}

function fileGlyph(file: OutgoingFileAttachment): string {
  const name = file.altText.toLowerCase();
  if (file.mediaType.includes('spreadsheet') || name.endsWith('.xlsx')) return '📊';
  if (file.mediaType.includes('word') || name.endsWith('.docx')) return '📄';
  return '📎';
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : 'file';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


/**
 * Non-blocking 1-click refinement buttons rendered below the answer. The
 * LLM emits these via `suggest_follow_ups`; a click fires a fresh user
 * turn using the option's `prompt` (which is a full self-contained
 * question, not just a label). Visually dezent — border + subtle bg, no
 * heavy color accent — so the eye treats them as *quick next steps*, not
 * as blocking UI like `ChoiceCard`.
 */
function FollowUpButtons({
  options,
  disabled,
  onChoose,
}: {
  options: FollowUpOption[];
  disabled: boolean;
  onChoose: (value: string) => void;
}): React.ReactElement {
  const t = useTranslations('chat');
  return (
    <div className="mt-3 border-t border-[color:var(--border)] pt-2">
      <div className="mb-2 text-[10px] font-medium tracking-wide text-[color:var(--fg-muted)] uppercase">
        {t('followUpsLabel')}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt, idx) => (
          <Button
            key={`${opt.label}-${String(idx)}`}
            variant="secondary"
            size="sm"
            pill
            onClick={() => {
              onChoose(opt.prompt);
            }}
            disabled={disabled}
            title={opt.prompt}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function StreamingDots(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 text-[color:var(--fg-muted)]">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${String(delay)}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Theme E0+E1 status row rendered under the assistant Markdown while a
 * turn is in flight. Mirrors the builder's liveness pill (BuilderChatPane)
 * so the operator sees the same kind of "what is the agent doing" pulse
 * in both UIs.
 */
function LivenessRow({
  liveness,
  tokensPerSec,
  lastUsage,
  elapsedSec,
  showInlineDots,
}: {
  liveness: Message['liveness'];
  tokensPerSec?: number;
  lastUsage?: Message['lastUsage'];
  elapsedSec: number;
  showInlineDots: boolean;
}): React.ReactElement {
  const t = useTranslations('chat');
  const stuck =
    liveness !== undefined && liveness.sinceLastActivityMs > 30000;
  return (
    <div
      className={[
        'mt-2 inline-flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em]',
        stuck
          ? 'text-[color:var(--danger)]'
          : 'text-[color:var(--fg-muted)]',
      ].join(' ')}
    >
      {showInlineDots && <StreamingDots />}
      <span>{t('streamLive', { seconds: elapsedSec })}</span>
      {liveness?.phase ? (
        <span className={phasePillClass(liveness.phase)}>
          {liveness.phase.replace('_', ' ')}
        </span>
      ) : null}
      {typeof liveness?.tokensThisIter === 'number' &&
      liveness.tokensThisIter > 0 ? (
        <span>
          · {String(liveness.tokensThisIter)}t
          {tokensPerSec !== undefined && tokensPerSec > 0
            ? ` @ ${formatTokenRate(tokensPerSec)}/s`
            : ''}
        </span>
      ) : null}
      {lastUsage && lastUsage.cacheReadInputTokens > 0 ? (
        <span className="text-[color:var(--success)]">
          {t('cacheBadge', { tokens: lastUsage.cacheReadInputTokens })}
        </span>
      ) : null}
      {liveness ? (
        <span>
          {t('iterationActivity', {
            iteration: liveness.iteration,
            gap: formatLivenessGap(liveness.sinceLastActivityMs, t),
          })}
          {liveness.toolCallsThisIter > 0
            ? t('toolsThisIter', { count: liveness.toolCallsThisIter })
            : ''}
          {stuck ? t('stuckHint') : ''}
        </span>
      ) : null}
    </div>
  );
}

function phasePillClass(
  phase: 'thinking' | 'streaming' | 'tool_running' | 'idle',
): string {
  const base =
    'inline-flex items-center rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em]';
  switch (phase) {
    case 'streaming':
      return `${base} bg-[color:var(--accent)]/15 text-[color:var(--accent)]`;
    case 'tool_running':
      return `${base} bg-[color:var(--warning)]/15 text-[color:var(--warning)]`;
    case 'thinking':
    case 'idle':
    default:
      return `${base} bg-[color:var(--state-loading)] text-[color:var(--fg-muted)]`;
  }
}

type ChatTFn = (key: string, values?: Record<string, string | number>) => string;

function formatLivenessGap(ms: number, t: ChatTFn): string {
  if (ms < 1000) return t('livenessGapMs', { ms: Math.max(0, Math.round(ms)) });
  return t('livenessGapSec', { seconds: (ms / 1000).toFixed(1) });
}

function formatTokenRate(rate: number): string {
  if (rate < 10) return rate.toFixed(1);
  return String(Math.round(rate));
}
