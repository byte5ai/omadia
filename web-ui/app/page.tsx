'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { Eraser } from 'lucide-react';
import { ChatTabs } from './_components/ChatTabs';
import { AgentPicker } from './_components/AgentPicker';
import { AgentUnavailableBanner } from './_components/AgentUnavailableBanner';
import { AgentUsagePills } from './_components/chat/AgentUsagePills';
import { AutoPromotedBanner } from './_components/chat/AutoPromotedBanner';
import { CaptureDisclosure } from './_components/chat/CaptureDisclosure';
import { ConfirmDialog } from './_components/ConfirmDialog';
import { NudgeCard, parseNudgeBlock } from './_components/chat/NudgeCard';
import { PlanProgressCard } from './_components/chat/PlanProgressCard';
import { PrivacyReceiptCard } from './_components/chat/PrivacyReceiptCard';
import { SaveMemoryButton } from './_components/chat/SaveMemoryButton';
import { Markdown } from './_components/Markdown';
import { resetChatSession } from './_lib/api';
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
} from './_lib/chatSessions';
import { useChatSessionsCtx } from './_lib/chatSessionsContext';
import { useStreamStore } from './_lib/streamStore';
import { ChoiceCard } from './_components/ChoiceCard';

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

  const [input, setInput] = useState('');
  const [resetPending, setResetPending] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
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

      <div className="border-b border-neutral-200 bg-white/60 px-6 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {/* Row 1 — stream info. Verlauf-Leeren wanderte 2026-05-26 als
              Eraser-Icon in den Composer (links neben Senden). */}
          <div className="flex flex-wrap items-center gap-3 text-neutral-500">
            <span>
              {t('streamLabel')} <code className="font-mono">/bot-api/chat/stream</code>
            </span>
            <span className="truncate font-mono text-[11px] text-neutral-400">
              {/* `activeId` is a client-only minted UUID — rendering it during
                  SSR produces a hydration mismatch (#95). Hold a placeholder
                  until `useChatSessions` finishes hydrating. */}
              scope={hydrating ? '…' : activeId}
            </span>
            {/* Phase A — Agent picker. Read-only pinned label after the
                first turn; dropdown before it. */}
            <AgentPicker
              pinnedSlug={activeSession.snapshot?.agentSlug}
              selectedSlug={selectedAgentSlug}
              onSelect={setSelectedAgentSlug}
            />
          </div>

          {/* Row 2 — Agent-Usage-Pills (only when anything was invoked) */}
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

      <footer className="border-t border-neutral-200 bg-white/80 px-6 py-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/80">
        <div className="mx-auto flex max-w-4xl items-end gap-2">
          <button
            type="button"
            onClick={requestReset}
            disabled={!canReset}
            className="rounded border border-neutral-300 bg-white p-2 text-neutral-500 transition hover:border-neutral-400 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
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
            placeholder={t('placeholder')}
            className="flex-1 resize-none rounded border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800"
            disabled={sending || hydrating}
          />
          {sending ? (
            <button
              type="button"
              onClick={abort}
              className="rounded border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              {t('stopButton')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                send();
              }}
              disabled={input.trim().length === 0 || hydrating}
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {t('sendButton')}
            </button>
          )}
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
      <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-400 dark:border-neutral-700">
        {t('sessionsLoading')}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
      <div className="font-medium">{session.title}</div>
      <div className="mt-1">{t('emptyStatePrompt')}</div>
      <div className="mt-2 text-xs text-neutral-400">
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
          'max-w-[85%] rounded-lg px-4 py-3 shadow-sm',
          isUser
            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
            : message.error
              ? 'bg-red-50 text-red-900 ring-1 ring-red-200 dark:bg-red-900/30 dark:text-red-100 dark:ring-red-800'
              : 'bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700',
        ].join(' ')}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm">{message.content}</div>
        ) : (
          <>
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
            {message.content.length > 0 ? (
              <Markdown
                source={message.content}
                highlightTerms={message.maskedValues}
              />
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
            <div className="mt-2 flex flex-wrap items-center border-t border-current/10 pt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              {message.telemetry && (
                <span>
                  tools={message.telemetry.tool_calls} · iterations=
                  {message.telemetry.iterations}
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
    <details className="mb-2 rounded bg-neutral-50 text-xs dark:bg-neutral-900/60" open>
      <summary className="cursor-pointer px-2 py-1 font-medium text-neutral-600 select-none dark:text-neutral-400">
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
      ? 'text-orange-600 dark:text-orange-400'
      : elapsedMs > 30_000
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-neutral-500'
    : 'text-neutral-500';

  const subEvents = tool.subEvents ?? [];

  return (
    <details
      className={[
        'rounded border text-[11px]',
        pending
          ? 'border-neutral-300 dark:border-neutral-700'
          : tool.isError
            ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40'
            : isKG
              ? 'border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40'
              : 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800',
      ].join(' ')}
      open={pending}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 font-mono select-none">
        <span>{status}</span>
        {icon && <span>{icon}</span>}
        <span className="font-semibold">{tool.name}</span>
        {inputPreview && (
          <span
            className="max-w-[40ch] truncate font-normal text-neutral-500 dark:text-neutral-400"
            title={inputPreview}
          >
            · {inputPreview}
          </span>
        )}
        {subEvents.length > 0 && (
          <span className="rounded bg-neutral-200 px-1 font-normal text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
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
      <div className="border-t border-neutral-200 px-2 py-1 dark:border-neutral-700">
        <div className="text-neutral-500">{t('inputLabel')}</div>
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
function ToolOutputWithNudge({ output }: { output: string }): React.ReactElement {
  const t = useTranslations('chat');
  const { cleaned } = parseNudgeBlock(output);
  return (
    <>
      <div className="mt-2 text-neutral-500">{t('outputLabel')}</div>
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
    <div className="mt-2 space-y-1 border-l-2 border-neutral-300 pl-2 dark:border-neutral-600">
      <div className="text-neutral-500">{t('subAgentTrace')}</div>
      {rows.map((row, idx) => {
        if (row.kind === 'iteration') {
          return (
            <div
              key={`iter-${String(idx)}`}
              className="text-[10px] text-neutral-500"
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
                ? 'border-neutral-300 dark:border-neutral-600'
                : row.result?.isError
                  ? 'border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-950/40'
                  : 'border-neutral-200 bg-white/60 dark:border-neutral-700 dark:bg-neutral-900/40',
            ].join(' ')}
          >
            <summary className="flex cursor-pointer items-center gap-2 px-2 py-0.5 font-mono select-none">
              <span>
                {pending ? '…' : row.result?.isError ? '✗' : '✓'}
              </span>
              <span className="font-semibold">{row.name ?? '?'}</span>
              {previewInput(row.input) && (
                <span
                  className="max-w-[36ch] truncate font-normal text-neutral-500"
                  title={previewInput(row.input) ?? ''}
                >
                  · {previewInput(row.input)}
                </span>
              )}
              <span className="ml-auto text-neutral-500">
                {formatMs(elapsedMs)}
              </span>
            </summary>
            <div className="border-t border-neutral-200 px-2 py-1 dark:border-neutral-700">
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
          className="block overflow-hidden rounded border border-neutral-200 bg-white p-2 transition hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900"
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
          <div className="mt-1 text-[10px] text-neutral-500">
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
          className="flex items-center gap-3 rounded border border-neutral-200 bg-white p-3 transition hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900"
        >
          <span aria-hidden className="text-xl">
            {fileGlyph(file)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{file.altText}</span>
            <span className="text-[10px] uppercase text-neutral-500">
              {fileExt(file.altText)}
              {file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ''}
            </span>
          </span>
          <span className="ml-auto text-sm text-neutral-400" aria-hidden>
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
    <div className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-700">
      <div className="mb-1.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
        {t('followUpsLabel')}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt, idx) => (
          <button
            key={`${opt.label}-${String(idx)}`}
            type="button"
            onClick={() => {
              onChoose(opt.prompt);
            }}
            disabled={disabled}
            title={opt.prompt}
            className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-[11px] font-medium text-neutral-700 transition hover:border-neutral-500 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StreamingDots(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 text-neutral-500">
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
        'mt-2 inline-flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em]',
        stuck
          ? 'text-red-600 dark:text-red-400'
          : 'text-neutral-500 dark:text-neutral-400',
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
        <span className="text-emerald-600 dark:text-emerald-400">
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
    'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em]';
  switch (phase) {
    case 'streaming':
      return `${base} bg-indigo-500/15 text-indigo-600 dark:text-indigo-400`;
    case 'tool_running':
      return `${base} bg-amber-500/15 text-amber-600 dark:text-amber-400`;
    case 'thinking':
    case 'idle':
    default:
      return `${base} bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300`;
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
