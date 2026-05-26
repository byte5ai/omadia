'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';

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
  const [pathname, setPathname] = useState<string>('');

  // Pull pathname client-side without forcing this component to suspend on
  // an RSC fetch — we just need to know "is the user looking at the chat
  // page right now?".
  useEffect(() => {
    const update = (): void => {
      setPathname(window.location.pathname);
    };
    update();
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('popstate', update);
    };
  }, []);

  const onChatRoute = pathname === '' || pathname === '/';
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
    if (!onChatRoute) router.push('/');
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
}

function StreamToast({
  record,
  t,
  onOpen,
  onDismiss,
}: StreamToastProps): React.ReactElement {
  const isTerminal =
    record.phase === 'done' ||
    record.phase === 'error' ||
    record.phase === 'aborted';
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
            <Loader2 size={14} className="animate-spin" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100">
              {phaseLabel}
              {record.toolName ? (
                <span className="ml-1 font-mono text-[10px] font-normal text-neutral-500">
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
              className="rounded p-0.5 text-neutral-400 opacity-60 transition hover:bg-neutral-200 hover:text-neutral-700 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
              aria-label={t('dismissAriaLabel')}
              title={t('dismissTitle')}
            >
              <X size={12} aria-hidden />
            </button>
          </div>
          {record.previewTail && (
            <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-neutral-600 dark:text-neutral-400">
              {record.previewTail}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500 dark:text-neutral-500">
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
                className="font-mono text-emerald-600 dark:text-emerald-400"
                title={t('cacheHitTitle', { n: record.cacheTokens })}
              >
                · 🟢 {formatTokenCount(record.cacheTokens)}
              </span>
            ) : null}
            {record.error ? (
              <span className="truncate text-red-600 dark:text-red-400">
                · {record.error}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
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
        border: 'border-emerald-300 dark:border-emerald-800',
        bg: 'bg-emerald-50 dark:bg-emerald-950/60',
        icon: 'text-emerald-700 dark:text-emerald-400',
        symbol: '✓',
      };
    case 'error':
      return {
        border: 'border-red-300 dark:border-red-800',
        bg: 'bg-red-50 dark:bg-red-950/60',
        icon: 'text-red-700 dark:text-red-400',
        symbol: '✗',
      };
    case 'aborted':
      return {
        border: 'border-neutral-300 dark:border-neutral-700',
        bg: 'bg-neutral-50 dark:bg-neutral-900',
        icon: 'text-neutral-500',
        symbol: '⏹',
      };
    default:
      return {
        border: 'border-indigo-200 dark:border-indigo-800',
        bg: 'bg-white dark:bg-neutral-900',
        icon: 'text-indigo-600 dark:text-indigo-400',
        symbol: '…',
      };
  }
}
