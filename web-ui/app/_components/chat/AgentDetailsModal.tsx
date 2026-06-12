'use client';

import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ChatSession, ToolEvent } from '../../_lib/chatSessions';
import type { AgentMeta } from '../../_lib/agentMapping';
import { cn } from '../../_lib/cn';

interface AgentDetailsModalProps {
  session: ChatSession;
  /** Which tool-names belong to the selected agent — from agentMapping. */
  matchingToolNames: string[];
  agent: AgentMeta | null;
  onClose: () => void;
}

/**
 * Modal with the individual tool calls that drove an agent's usage count.
 * Opened when a pill in AgentUsagePills is clicked. Animations use the
 * byte5 motion tokens (gentle, never bouncy — see README).
 */
export function AgentDetailsModal({
  session,
  matchingToolNames,
  agent,
  onClose,
}: AgentDetailsModalProps): React.ReactElement {
  const t = useTranslations('agentDetailsModal');
  // Keyboard: Escape closes.
  useEffect(() => {
    if (!agent) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [agent, onClose]);

  const calls = useMemo(() => {
    if (!agent) return [];
    return collectCalls(session, matchingToolNames);
  }, [session, matchingToolNames, agent]);

  return (
    <AnimatePresence>
      {agent ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label={t('ariaLabelTitle', { label: agent.label })}
          initial="hidden"
          animate="shown"
          exit="hidden"
          variants={BACKDROP_VARIANTS}
          transition={TRANSITION_FAST}
        >
          <motion.button
            type="button"
            onClick={onClose}
            aria-label={t('ariaCloseBackdrop')}
            className="absolute inset-0 bg-[color:var(--bg-modal-overlay)] backdrop-blur-[2px]"
            variants={BACKDROP_VARIANTS}
            transition={TRANSITION_FAST}
          />

          <motion.div
            variants={PANEL_VARIANTS}
            transition={TRANSITION_BASE}
            className={cn(
              'relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col',
              'rounded-t-lg sm:rounded-lg',
              'bg-[color:var(--bg-elevated)] text-[color:var(--fg)]',
              'shadow-[var(--shadow-lg)]',
            )}
          >
            <header className="flex items-start justify-between gap-4 border-b border-[color:var(--border)] px-6 py-5">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
                  {t('agentLabel')}
                </div>
                <h3 className="font-display mt-1 text-[26px] leading-[1.1] text-[color:var(--fg-strong)]">
                  {agent.label}
                </h3>
                <p className="font-mono-num mt-1 text-[11px] text-[color:var(--fg-muted)]">
                  {agent.id} · {t('callCount', { count: calls.length })}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('ariaClose')}
                className="rounded-full p-2 text-[color:var(--fg-muted)] transition-colors duration-[100ms] ease-[var(--easing-standard)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {calls.length === 0 ? (
                <p className="text-sm italic text-[color:var(--fg-muted)]">
                  {t('noCallsInSession')}
                </p>
              ) : (
                <ol className="space-y-4">
                  {calls.map((call, idx) => (
                    <ToolCallRow
                      key={call.event.id ?? idx}
                      index={idx + 1}
                      call={call}
                    />
                  ))}
                </ol>
              )}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-[color:var(--border)] bg-[color:var(--bg-soft)] px-6 py-3">
              <p className="text-[11px] leading-relaxed text-[color:var(--fg-muted)]">
                                {t('footerNote')}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full px-4 py-1.5 text-[12px] font-semibold text-[color:var(--fg-strong)] transition-colors duration-[100ms] ease-[var(--easing-standard)] hover:bg-[color:var(--bg-elevated)]"
              >
                {t('closeButton')}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Data shaping — collect matching tool events with their message context
// ---------------------------------------------------------------------------

interface Call {
  event: ToolEvent;
  messageStartedAt: number;
}

function collectCalls(
  session: ChatSession,
  toolNames: string[],
): Call[] {
  const names = new Set(toolNames);
  const out: Call[] = [];
  for (const message of session.messages) {
    if (!message.tools) continue;
    for (const tool of message.tools) {
      if (!names.has(tool.name)) continue;
      out.push({ event: tool, messageStartedAt: message.startedAt });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motion variants — byte5-brand easing: gentle, never bouncy
// ---------------------------------------------------------------------------

const EASE_OUT: [number, number, number, number] = [0.22, 0.61, 0.36, 1];
const TRANSITION_FAST = { duration: 0.14, ease: EASE_OUT };
const TRANSITION_BASE = { duration: 0.22, ease: EASE_OUT };

const BACKDROP_VARIANTS = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
};

const PANEL_VARIANTS = {
  hidden: { opacity: 0, y: 16, scale: 0.98 },
  shown: { opacity: 1, y: 0, scale: 1 },
};

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ToolCallRow({
  index,
  call,
}: {
  index: number;
  call: Call;
}): React.ReactElement {
  const t = useTranslations('agentDetailsModal');
  const { event, messageStartedAt } = call;
  const relativeStartMs =
    (event.startedAt ?? messageStartedAt) - messageStartedAt;
  const relativeLabel =
    relativeStartMs > 0 ? `+${formatMs(relativeStartMs)}` : '±0ms';
  const inputPreview = formatInputPreview(event.input);
  const outputPreview = formatOutputPreview(event.output);

  return (
    <li className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-4">
      <header className="flex items-center gap-3">
        <span className="font-mono-num inline-flex size-6 items-center justify-center rounded-full bg-[color:var(--bg-elevated)] text-[10px] font-semibold text-[color:var(--fg-strong)]">
          {index}
        </span>
        <span className="font-mono-num text-[12px] text-[color:var(--fg-strong)]">
          {event.name}
        </span>
        <span className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
          {relativeLabel}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {event.isError ? (
            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--danger)]">
              {t('statusError')}
            </span>
          ) : (
            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--success)]">
              {t('statusOk')}
            </span>
          )}
          {typeof event.durationMs === 'number' ? (
            <span className="font-mono-num text-[10px] text-[color:var(--fg-muted)]">
              {formatMs(event.durationMs)}
            </span>
          ) : null}
        </span>
      </header>

      {inputPreview ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">
            {t('inputLabel')}
          </div>
          <pre className="font-mono-num mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[color:var(--bg-elevated)] p-2 text-[11px] leading-relaxed text-[color:var(--fg)]">
            {inputPreview}
          </pre>
        </div>
      ) : null}

      {outputPreview ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">
            {t('outputLabel')}
          </div>
          <pre className="font-mono-num mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[color:var(--bg-elevated)] p-2 text-[11px] leading-relaxed text-[color:var(--fg)]">
            {outputPreview}
          </pre>
        </div>
      ) : null}

      {event.subEvents && event.subEvents.length > 0 ? (
        <div className="mt-3 text-[11px] text-[color:var(--fg-muted)]">
                    {t('subIterations', { count: event.subEvents.length })}
        </div>
      ) : null}
    </li>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

function formatInputPreview(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    return truncate(text, 600);
  } catch {
    return null;
  }
}

function formatOutputPreview(output: string | undefined): string | null {
  if (!output) return null;
  return truncate(output, 800);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
