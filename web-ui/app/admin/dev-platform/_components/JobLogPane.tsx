'use client';

import { useRef } from 'react';

import { useTranslations } from 'next-intl';

import { ScrollToBottomButton } from '@/app/_components/ScrollToBottomButton';
import { useStickToBottom } from '@/app/_lib/useStickToBottom';

import type { LogItem } from '../_lib/toolCallLog';
import { ToolCallCard } from './ToolCallCard';

/**
 * Epic #470 W0 — the live log pane (UI spec §5). Monospace, sunken surface,
 * stick-to-bottom via `useStickToBottom` (issue #404): follows while at the
 * bottom, pauses when the user scrolls up, and shows the existing
 * `ScrollToBottomButton` when detached. `role="log"` with `aria-live="off"` —
 * a token stream announced line-by-line is noise (§13); a separate polite
 * region carries the connection state instead.
 *
 * Items come pre-folded from `toolCallLog.ts`: agent narration renders as
 * plain text (stdout in `--fg-muted`, stderr in `--danger`), tool calls
 * render as a collapsible `ToolCallCard` instead of a raw `$ Name {...json}`
 * dump. The pane scrolls inside its own `overflow` box; the page never
 * scrolls sideways. No toast on disconnect.
 */

export type LogTextStream = 'agent' | 'stderr';

export type LogConnection = 'live' | 'reconnecting' | 'closed';

const STREAM_CLASS: Record<LogTextStream, string> = {
  agent: 'text-[color:var(--fg-muted)]',
  stderr: 'text-[color:var(--danger)]',
};

export function JobLogPane({
  items,
  connection,
  lastEventAgoSec,
}: {
  items: LogItem[];
  connection: LogConnection;
  lastEventAgoSec: number | null;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useStickToBottom(scrollRef, [items.length]);

  const connectionText =
    connection === 'live'
      ? t('connection.live', { seconds: lastEventAgoSec ?? 0 })
      : connection === 'reconnecting'
        ? t('connection.reconnecting')
        : t('connection.closed');
  const connectionClass =
    connection === 'reconnecting' ? 'text-[color:var(--warning)]' : 'text-[color:var(--fg-subtle)]';

  return (
    <div>
      <div className="relative">
        <div
          ref={scrollRef}
          role="log"
          aria-live="off"
          className="max-h-[60vh] overflow-x-auto overflow-y-auto rounded-lg border border-[color:var(--border)] lume-surface-sunken p-4 font-mono text-xs leading-[1.6]"
        >
          {items.length === 0 ? (
            <div className="text-[color:var(--fg-subtle)]">{t('logEmpty')}</div>
          ) : (
            items.map((item) =>
              item.kind === 'tool' ? (
                <ToolCallCard key={item.entry.id} entry={item.entry} />
              ) : (
                <div key={item.id} className={`whitespace-pre-wrap ${STREAM_CLASS[item.stream]}`}>
                  {item.text}
                </div>
              ),
            )
          )}
        </div>
        <ScrollToBottomButton
          visible={!isAtBottom}
          onClick={scrollToBottom}
          ariaLabel={t('scrollToBottom')}
        />
      </div>
      <p aria-live="polite" className={`mt-2 text-xs ${connectionClass}`}>
        {connectionText}
      </p>
    </div>
  );
}
