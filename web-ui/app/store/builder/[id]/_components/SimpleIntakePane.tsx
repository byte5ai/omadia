'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ScrollToBottomButton } from '@/app/_components/ScrollToBottomButton';
import { useStickToBottom } from '@/app/_lib/useStickToBottom';
import { motion } from 'framer-motion';
import { Send, Sparkles, StopCircle } from 'lucide-react';

import {
  ApiError,
  resolveBuilderUserChoice,
  streamBuilderTurn,
} from '../../../../_lib/api';
import type {
  BuilderModelId,
  BuilderTurnEvent,
  TranscriptEntry,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';
import { ChoiceCard } from '../../../../_components/ChoiceCard';

import { BuilderMarkdown } from './BuilderMarkdown';

interface SimpleMessage {
  key: string;
  role: 'user' | 'assistant';
  text: string;
}

interface SimpleIntakePaneProps {
  draftId: string;
  /** Codegen model resolved from the draft. */
  model: BuilderModelId;
  /** Persisted transcript loaded with the draft. */
  initialTranscript: TranscriptEntry[];
  /** Pending `ask_user_choice` smart-card, hoisted by the Workspace from
   *  the SpecEventBus and shared with the Extended view. */
  pendingUserChoice?: {
    choiceId: string;
    question: string;
    options: ReadonlyArray<{
      value: string;
      label: string;
      description?: string;
    }>;
  } | null;
  /** Called optimistically after the operator picks an option so the
   *  parent can clear the card without waiting for the bus echo. */
  onUserChoiceResolved?: () => void;
  /** Issue #224 — lifts the in-flight turn flag to the Workspace so it can
   *  lock the simple/extended view toggle while a reply streams (toggling
   *  unmounts this pane and would abort the stream + drop the live message).
   *  Fires `false` on unmount so a stale `true` never wedges the toggle. */
  onStreamingChange?: (streaming: boolean) => void;
}

const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;

/**
 * Simplified intake pane for the No-Code (Einfach) builder view.
 *
 * Drives the exact same `POST /drafts/:id/turn` stream as the full
 * {@link BuilderChatPane}, but deliberately strips every technical surface a
 * non-technical operator does not need:
 *
 *   - No tool-call cards, no spec_patch / slot_patch / lint event chips, no
 *     token / cache / iteration telemetry.
 *   - While the agent works we show a single calm status line under a row of
 *     breathing dots instead of the granular step-by-step transcript.
 *   - Only warm, plain user / assistant chat bubbles are rendered.
 *
 * The draft itself stays up to date through the Workspace's SpecEventBus
 * subscription (it re-fetches on every agent mutation), so this pane never
 * has to surface the structured patches itself.
 */
export function SimpleIntakePane({
  draftId,
  model,
  initialTranscript,
  pendingUserChoice,
  onUserChoiceResolved,
  onStreamingChange,
}: SimpleIntakePaneProps): React.ReactElement {
  const t = useTranslations('builder.simple.intake');
  const [messages, setMessages] = useState<SimpleMessage[]>(() =>
    initialTranscript.map((entry, idx) => ({
      key: `init-${String(idx)}`,
      role: entry.role,
      text: entry.content,
    })),
  );
  const [input, setInput] = useState('');
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Issue #224 — mirror the in-flight flag up to the Workspace, and force it
  // back to `false` on unmount so the view toggle never stays locked.
  useEffect(() => {
    onStreamingChange?.(inflight);
    return () => onStreamingChange?.(false);
  }, [inflight, onStreamingChange]);
  // Single human-readable status line shown under the breathing dots while
  // the agent works. Replaced (never appended) as events arrive so the
  // operator always sees one calm "what's happening now" sentence.
  const [statusKey, setStatusKey] = useState<StatusKey>('statusDefault');

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputId = useId();
  const counterRef = useRef(0);
  const nextKey = useCallback((prefix: string) => {
    counterRef.current += 1;
    return `${prefix}-${String(counterRef.current)}`;
  }, []);

  // Issue #404 — only keep following the transcript while the user is
  // actually at the bottom; scrolling up mid-stream now holds position.
  const { isAtBottom, scrollToBottom } = useStickToBottom(scrollRef, [
    messages,
    inflight,
    statusKey,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onSend = useCallback(
    async (messageOverride?: string) => {
      const source = messageOverride ?? input;
      const trimmed = source.trim();
      if (!trimmed || inflight) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setInflight(true);
      setStatusKey('statusDefault');
      setInput('');
      setMessages((prev) => [
        ...prev,
        { key: nextKey('msg'), role: 'user', text: trimmed },
      ]);
      scrollToBottom();

      try {
        for await (const ev of streamBuilderTurn(draftId, trimmed, {
          model,
          signal: controller.signal,
        })) {
          applyEvent(ev);
          if (ev.type === 'turn_done') break;
          if (ev.type === 'error') {
            setError(`${ev.code}: ${ev.message}`);
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // User-initiated stop — not an error.
        } else if (err instanceof ApiError) {
          setError(humanizeApiError(err));
        } else if (err instanceof Error) {
          setError(t('errorLostConnection', { message: err.message }));
        } else {
          setError(t('errorUnknown'));
        }
      } finally {
        setInflight(false);
        abortRef.current = null;
      }

      function applyEvent(ev: BuilderTurnEvent): void {
        const nextStatus = friendlyStatusKey(ev);
        if (nextStatus !== null) setStatusKey(nextStatus);

        // Only assistant prose is surfaced — the user message was already
        // optimistically inserted above on send.
        if (ev.type === 'chat_message' && ev.role === 'assistant') {
          setMessages((prev) => [
            ...prev,
            { key: nextKey('msg'), role: 'assistant', text: ev.text },
          ]);
        }
      }
    },
    [draftId, inflight, input, model, nextKey, scrollToBottom, t],
  );

  const onStop = useCallback(() => {
    abortRef.current?.abort();
    setTimeout(() => {
      setInflight(false);
      abortRef.current = null;
    }, 5000);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  const [choiceSubmitting, setChoiceSubmitting] = useState(false);
  const onChooseUserChoice = useCallback(
    async (value: string) => {
      if (!pendingUserChoice || choiceSubmitting) return;
      const { choiceId, options } = pendingUserChoice;
      const picked = options.find((o) => o.value === value);
      const transcriptText = picked?.label ?? value;
      setMessages((prev) => [
        ...prev,
        { key: nextKey('msg'), role: 'user', text: transcriptText },
      ]);
      scrollToBottom();
      setChoiceSubmitting(true);
      setError(null);
      onUserChoiceResolved?.();
      try {
        await resolveBuilderUserChoice({ draftId, choiceId, value });
      } catch (err) {
        if (err instanceof ApiError) {
          setError(humanizeApiError(err));
        } else if (err instanceof Error) {
          setError(t('errorChoiceFailedMessage', { message: err.message }));
        } else {
          setError(t('errorChoiceFailed'));
        }
      } finally {
        setChoiceSubmitting(false);
      }
    },
    [
      pendingUserChoice,
      choiceSubmitting,
      draftId,
      nextKey,
      onUserChoiceResolved,
      scrollToBottom,
      t,
    ],
  );

  const empty = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full space-y-3 overflow-y-auto px-6 py-4">
          {empty && !inflight ? (
            <IntakeHero onPick={(text) => void onSend(text)} />
          ) : (
            messages.map((m) => (
              <motion.div
                key={m.key}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.32, ease: EASE_OUT }}
                className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[86%] px-4 py-3 text-[14.5px] leading-relaxed',
                    m.role === 'user'
                      ? 'rounded-lg rounded-br-sm bg-[color:var(--accent)] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-sm)]'
                      : 'rounded-lg rounded-bl-sm bg-[color:var(--bg-soft)] text-[color:var(--fg-strong)]',
                  )}
                >
                  {m.role === 'user' ? (
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  ) : (
                    <BuilderMarkdown source={m.text} />
                  )}
                </div>
              </motion.div>
            ))
          )}

          {pendingUserChoice ? (
            <ChoiceCard
              choice={{
                question: pendingUserChoice.question,
                options: pendingUserChoice.options.map((o) => ({
                  value: o.value,
                  label: o.label,
                })),
              }}
              disabled={choiceSubmitting}
              onChoose={(v) => {
                void onChooseUserChoice(v);
              }}
            />
          ) : null}

          {inflight ? <LoadingLine status={t(statusKey)} /> : null}
        </div>
        <ScrollToBottomButton
          visible={!isAtBottom}
          onClick={scrollToBottom}
          ariaLabel={t('scrollToBottomAriaLabel')}
        />
      </div>

      {error ? (
        <div className="mx-6 mb-2 flex items-start gap-2 rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/8 px-3 py-3 text-[13px] text-[color:var(--danger)]">
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="border-t border-[color:var(--divider)] px-6 py-4">
        <label className="sr-only" htmlFor={inputId}>
          {t('inputLabel')}
        </label>
        <div className="flex items-end gap-3">
          <textarea
            id={inputId}
            value={input}
            disabled={inflight}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={inflight ? t('placeholderBusy') : t('placeholderIdle')}
            className="min-h-[50px] flex-1 resize-none rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)] px-4 py-3 text-[14.5px] leading-snug text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)] transition-colors focus:border-[color:var(--accent)] focus:outline-none focus:ring-4 focus:ring-[color:var(--accent)]/10 disabled:opacity-60"
          />
          {inflight ? (
            <Button
              variant="danger"
              pill
              onClick={onStop}
              className="h-[50px] shrink-0 text-[13px]"
            >
              <StopCircle className="size-4" aria-hidden />
              {t('stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              pill
              onClick={() => void onSend()}
              disabled={input.trim().length === 0}
              className="h-[50px] shrink-0 text-[14px]"
            >
              <Send className="size-4" aria-hidden />
              {t('send')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type StatusKey =
  | 'statusDefault'
  | 'statusReading'
  | 'statusConfiguring'
  | 'statusTeaching'
  | 'statusWaitingChoice'
  | 'statusWorking'
  | 'statusChecking'
  | 'statusThinking'
  | 'statusFormulating'
  | 'statusBusy';

/**
 * Map a raw {@link BuilderTurnEvent} onto one calm status-message key.
 * Returns `null` when the event carries no status meaning so the caller
 * keeps the previously shown line (avoids flicker between heartbeats).
 */
function friendlyStatusKey(ev: BuilderTurnEvent): StatusKey | null {
  switch (ev.type) {
    case 'turn_started':
      return 'statusReading';
    case 'tool_use':
      if (ev.toolId === 'patch_spec') return 'statusConfiguring';
      if (ev.toolId === 'fill_slot') return 'statusTeaching';
      if (ev.toolId === 'ask_user_choice') return 'statusWaitingChoice';
      return 'statusWorking';
    case 'slot_patch':
      return 'statusTeaching';
    case 'spec_patch':
      return 'statusConfiguring';
    case 'lint_result':
      return 'statusChecking';
    case 'heartbeat':
      if (ev.phase === 'thinking') return 'statusThinking';
      if (ev.phase === 'streaming') return 'statusFormulating';
      if (ev.phase === 'tool_running') return 'statusBusy';
      return null;
    default:
      return null;
  }
}

function LoadingLine({ status }: { status: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[color:var(--bg-soft)] px-4 py-3">
      <BreathingDots />
      <span className="text-[13.5px] text-[color:var(--fg-muted)]" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

function BreathingDots(): React.ReactElement {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-2 rounded-full bg-[color:var(--accent)]"
          animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
          transition={{
            duration: 1.1,
            ease: 'easeInOut',
            repeat: Infinity,
            delay: i * 0.18,
          }}
        />
      ))}
    </span>
  );
}

function IntakeHero({
  onPick,
}: {
  onPick: (text: string) => void;
}): React.ReactElement {
  const t = useTranslations('builder.simple.intake');
  const examples = [t('example1'), t('example2'), t('example3')];
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <motion.span
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.45, ease: EASE_OUT }}
        className="inline-flex size-14 items-center justify-center rounded-full bg-[color:var(--accent)]/12 text-[color:var(--accent)]"
      >
        <Sparkles className="size-7" aria-hidden />
      </motion.span>
      <div>
        <p className="font-display text-[21px] text-[color:var(--fg-strong)]">
          {t('heroTitle')}
        </p>
        <p className="mx-auto mt-2 max-w-[400px] text-[14.5px] leading-relaxed text-[color:var(--fg-muted)]">
          {t('heroSubtitle')}
        </p>
      </div>
      <div className="mt-1 flex flex-col items-stretch gap-2">
        <p className="text-[12px] font-semibold text-[color:var(--fg-subtle)]">
          {t('examplesLabel')}
        </p>
        {examples.map((prompt) => (
          <Button
            key={prompt}
            variant="secondary"
            pill
            onClick={() => onPick(prompt)}
            className="text-[13.5px]"
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function humanizeApiError(err: ApiError): string {
  try {
    const parsed = JSON.parse(err.body) as { code?: string; message?: string };
    if (parsed.code && parsed.message) return `${parsed.code}: ${parsed.message}`;
    if (parsed.message) return parsed.message;
  } catch {
    // ignore
  }
  return err.message;
}
