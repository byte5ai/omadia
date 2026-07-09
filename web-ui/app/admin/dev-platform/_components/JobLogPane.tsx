'use client';

import { useRef } from 'react';

import { useTranslations } from 'next-intl';

import { ScrollToBottomButton } from '@/app/_components/ScrollToBottomButton';
import { useStickToBottom } from '@/app/_lib/useStickToBottom';

/**
 * Epic #470 W0 — the live log pane (UI spec §5). Monospace, sunken surface,
 * stick-to-bottom via `useStickToBottom` (issue #404): follows while at the
 * bottom, pauses when the user scrolls up, and shows the existing
 * `ScrollToBottomButton` when detached. `role="log"` with `aria-live="off"` —
 * a token stream announced line-by-line is noise (§13); a separate polite
 * region carries the connection state instead.
 *
 * Tool-invocation lines are `$`-prefixed in `--fg-strong`, stdout in
 * `--fg-muted`, stderr in `--danger` — text color only, no filled gutters.
 * The pane scrolls inside its own `overflow` box; the page never scrolls
 * sideways. No toast on disconnect.
 */

export type LogStream = 'tool' | 'agent' | 'stderr';

export interface LogLine {
  id: string;
  stream: LogStream;
  text: string;
}

export type LogConnection = 'live' | 'reconnecting' | 'closed';

const STREAM_CLASS: Record<LogStream, string> = {
  tool: 'text-[color:var(--fg-strong)]',
  agent: 'text-[color:var(--fg-muted)]',
  stderr: 'text-[color:var(--danger)]',
};

export function JobLogPane({
  lines,
  connection,
  lastEventAgoSec,
}: {
  lines: LogLine[];
  connection: LogConnection;
  lastEventAgoSec: number | null;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useStickToBottom(scrollRef, [lines.length]);

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
          {lines.length === 0 ? (
            <div className="text-[color:var(--fg-subtle)]">{t('logEmpty')}</div>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={`whitespace-pre-wrap ${STREAM_CLASS[line.stream]}`}>
                {line.stream === 'tool' ? '$ ' : ''}
                {line.text}
              </div>
            ))
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
