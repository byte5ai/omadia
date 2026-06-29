'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { AnimatePresence, motion } from 'framer-motion';
import { Ban, X } from 'lucide-react';

import { Button } from '@/app/_components/ui/Button';
import { useChatSessionsCtx } from '../_lib/chatSessionsContext';
import {
  type StreamPhase,
  type StreamRecord,
  useStreamStore,
} from '../_lib/streamStore';

/**
 * Floating toast stack rendered at the bottom-right of every route. Shows
 * one toast per active stream whose chat-session is NOT currently in view
 * (background streams only — when the user is already looking at the chat,
 * the inline streaming UI is enough).
 *
 * Active streams show a live preview tail + spinner. Terminal streams
 * (done / error / aborted) linger for a few seconds with a final summary
 * so the user knows the answer is ready before the toast disappears.
 */
export function StreamToasts(): React.ReactElement {
  const t = useTranslations('streamToasts');
  const router = useRouter();
  const store = useStreamStore();
  const { activeId, setActive } = useChatSessionsCtx();
  // Next.js App Router does client-side navigation (router.push / Link)
  // without firing `popstate`, so the previous `window.location.pathname
  // + popstate` pattern locked this component to whatever route it first
  // rendered on. `usePathname` re-renders on every client-side route
  // change, so toasts correctly appear once the user leaves the chat
  // page mid-stream and disappear when they return.
  const pathname = usePathname();
  const onChatRoute = pathname === '/chat' || pathname?.startsWith('/chat');
  const visibleRecords: StreamRecord[] = [];
  for (const rec of store.records.values()) {
    // Hide records that the user is currently viewing in-page: the user is
    // on the chat page AND the record is for the active session.
    if (onChatRoute && rec.sessionId === activeId) continue;
    visibleRecords.push(rec);
  }
  // Newest first for stacking.
  visibleRecords.sort((a, b) => b.lastEventAt - a.lastEventAt);
  // Cap to 3 visible — anything more becomes noise.
  const trimmed = visibleRecords.slice(0, 3);

  const openChat = (sessionId: string): void => {
    setActive(sessionId);
    if (!onChatRoute) router.push('/chat');
  };

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-96 flex-col gap-2"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {trimmed.map((rec) => (
          <motion.div
            key={rec.sessionId}
            layout
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-auto"
          >
            <StreamToast
              record={rec}
              t={t}
              onOpen={() => {
                openChat(rec.sessionId);
              }}
              onDismiss={() => {
                // Visual-only: hide the toast but let the stream finish in
                // the background. The message still lands in ChatSessions.
                store.dismiss(rec.sessionId);
              }}
              onAbort={() => {
                // Real stop: aborts the underlying fetch via the store's
                // AbortController. Gated behind the confirm modal.
                store.abort(rec.sessionId);
              }}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

interface StreamToastProps {
  record: StreamRecord;
  t: ReturnType<typeof useTranslations>;
  onOpen: () => void;
  onDismiss: () => void;
  onAbort: () => void;
}

function StreamToast({
  record,
  t,
  onOpen,
  onDismiss,
  onAbort,
}: StreamToastProps): React.ReactElement {
  const isTerminal =
    record.phase === 'done' ||
    record.phase === 'error' ||
    record.phase === 'aborted';
  // Whether the abort-confirmation modal is currently open for this toast.
  const [confirming, setConfirming] = useState(false);
  const phaseLabel = phaseLabelFor(record.phase, t);
  // Tick once a second while active so the elapsed-seconds line stays
  // honest. Terminal toasts freeze at their last event time — no point
  // re-rendering them every second.
  const now = useTickingNow(!isTerminal);
  const elapsedSec = Math.max(
    0,
    Math.round(((isTerminal ? record.lastEventAt : now) - record.startedAt) / 1000),
  );

  const palette = paletteFor(record.phase);

  return (
    <div
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      className={`group cursor-pointer rounded-lg border ${palette.border} ${palette.bg} px-3 py-2 shadow-md transition hover:shadow-lg`}
    >
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 ${palette.icon}`}>
          {isTerminal ? (
            <span className="text-base leading-none">{palette.symbol}</span>
          ) : (
            <span className="lume-busy-dots" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-xs font-semibold text-[color:var(--fg-strong)]">
              {phaseLabel}
              {record.toolName ? (
                <span className="ml-1 font-mono text-[10px] font-normal text-[color:var(--fg-muted)]">
                  · {record.toolName}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              className="rounded p-0.5 text-[color:var(--fg-subtle)] opacity-60 transition hover:bg-[color:var(--state-loading)] hover:text-[color:var(--fg)] group-hover:opacity-100"
              aria-label={t('dismissAriaLabel')}
              title={t('dismissTitle')}
            >
              <X size={12} aria-hidden />
            </button>
          </div>
          {record.previewTail && (
            <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-[color:var(--fg-muted)]">
              {record.previewTail}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-[color:var(--fg-muted)]">
            <span>{t('elapsedSec', { sec: elapsedSec })}</span>
            {typeof record.tokensIn === 'number' && record.tokensIn > 0 ? (
              <span
                className="font-mono"
                title={t('tokensInTitle', { n: record.tokensIn })}
              >
                · ↓ {formatTokenCount(record.tokensIn)}
              </span>
            ) : null}
            {typeof record.tokensOut === 'number' && record.tokensOut > 0 ? (
              <span
                className="font-mono"
                title={t('tokensOutTitle', { n: record.tokensOut })}
              >
                ↑ {formatTokenCount(record.tokensOut)}
              </span>
            ) : null}
            {typeof record.cacheTokens === 'number' && record.cacheTokens > 0 ? (
              <span
                className="font-mono text-[color:var(--success)]"
                title={t('cacheHitTitle', { n: record.cacheTokens })}
              >
                · 🟢 {formatTokenCount(record.cacheTokens)}
              </span>
            ) : null}
            {record.error ? (
              <span className="truncate text-[color:var(--danger)]">
                · {record.error}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {/* Real-stop affordance — only while the stream is still running.
          Clicking opens a confirm modal; confirming calls onAbort(), which
          aborts the underlying fetch. Separate from the top-right X, which
          only hides the toast. */}
      {!isTerminal ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 px-2 py-1 text-[11px] font-medium text-[color:var(--danger)] transition hover:bg-[color:var(--danger)]/8"
        >
          <Ban size={12} aria-hidden />
          {t('abortButton')}
        </button>
      ) : null}
      <AnimatePresence>
        {confirming ? (
          <AbortConfirmModal
            t={t}
            onConfirm={() => {
              setConfirming(false);
              onAbort();
            }}
            onCancel={() => {
              setConfirming(false);
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

interface AbortConfirmModalProps {
  t: ReturnType<typeof useTranslations>;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Lightweight custom confirmation dialog (no native window.confirm). Rendered
 * through a portal to <body> so its fixed positioning is immune to the
 * transformed motion ancestors of the toast stack. Closes on Escape or
 * backdrop click; the safe "keep running" action is auto-focused.
 */
function AbortConfirmModal({
  t,
  onConfirm,
  onCancel,
}: AbortConfirmModalProps): React.ReactPortal | null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
      role="presentation"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stream-abort-title"
        aria-describedby="stream-abort-body"
        className="w-full max-w-xs rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-xl"
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.14 }}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2
          id="stream-abort-title"
          className="text-sm font-semibold text-[color:var(--fg-strong)]"
        >
          {t('abortConfirmTitle')}
        </h2>
        <p
          id="stream-abort-body"
          className="mt-1 text-xs leading-snug text-[color:var(--fg-muted)]"
        >
          {t('abortConfirmBody')}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="rounded-md border border-[color:var(--border)] px-3 py-2 text-xs font-medium text-[color:var(--fg)] transition hover:bg-[color:var(--bg-soft)]"
          >
            {t('abortConfirmKeep')}
          </button>
          <Button
            variant="danger"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
          >
            {t('abortConfirmStop')}
          </Button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** "1.2k" / "340" / "1.45M" — keeps the toast row compact. */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

/** Re-renders the caller every second when `active` is true. Returns the
 *  current wall-clock at the last tick. */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return now;
}

function phaseLabelFor(
  phase: StreamPhase,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (phase) {
    case 'pending':
    case 'thinking':
      return t('phaseThinking');
    case 'streaming':
      return t('phaseStreaming');
    case 'tool_running':
      return t('phaseToolRunning');
    case 'done':
      return t('phaseDone');
    case 'error':
      return t('phaseError');
    case 'aborted':
      return t('phaseAborted');
  }
}

function paletteFor(phase: StreamPhase): {
  border: string;
  bg: string;
  icon: string;
  symbol: string;
} {
  switch (phase) {
    case 'done':
      return {
        border: 'border-[color:var(--success)]',
        bg: 'bg-[color:var(--success)]/10',
        icon: 'text-[color:var(--success)]',
        symbol: '✓',
      };
    case 'error':
      return {
        border: 'border-[color:var(--danger-edge)]',
        bg: 'bg-[color:var(--danger)]/8',
        icon: 'text-[color:var(--danger)]',
        symbol: '✗',
      };
    case 'aborted':
      return {
        border: 'border-[color:var(--border)]',
        bg: 'bg-[color:var(--bg-soft)]',
        icon: 'text-[color:var(--fg-muted)]',
        symbol: '⏹',
      };
    default:
      return {
        border: 'border-[color:var(--accent)]',
        bg: 'bg-[color:var(--bg-elevated)]',
        icon: 'text-[color:var(--accent)]',
        symbol: '…',
      };
  }
}
