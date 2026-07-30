'use client';

import { useTranslations } from 'next-intl';

import { taskCardLabel, type TaskCardSeed } from './taskChatCardState';

/**
 * W2-2 (issue #543) — the generic long-running task card, rendered inline in
 * chat whenever the orchestrator calls any `<tool>_start` from the task seam.
 *
 * Deliberately minimal, and deliberately NOT a live view. `dev_job` has its own
 * richer card (`DevJobChatCard`) because it has an authorized SSE event tail and
 * a human gate to offer; a generic task has neither — its only read path is the
 * model calling `<tool>_status`. So this card states what was started and that
 * the answer arrives separately, which is the honest UX for the deferred shape.
 *
 * PRIVACY: renders seed metadata only (ids, kind, progress label). The task
 * result is never on the card — it is delivered through `<tool>_status`, whose
 * return value passes the orchestrator's `dispatchTool` privacy pass. Adding a
 * result field here would route it around the Privacy Shield data plane.
 *
 * Lume: state is text/edge only — no spinners.
 */
export function TaskChatCard({ seed }: { seed: TaskCardSeed }): React.ReactElement {
  const t = useTranslations('chat.task');
  const label = taskCardLabel(seed.tool);

  return (
    <div
      className="rounded border-l-2 border-l-[color:var(--edge-info)] bg-[color:var(--bg-soft)] px-2 py-1.5"
      data-testid="task-chat-card"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-[color:var(--fg)]">{t('started', { label })}</span>
        <span className="text-[color:var(--fg-muted)] lume-busy-dots">{t('running')}</span>
      </div>
      <div className="mt-0.5 text-[color:var(--fg-muted)]">
        {t('deferredHint')}
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-[color:var(--fg-subtle)]">
        {t('taskId', { id: seed.taskId })}
        {seed.phase ? ` · ${t('phase', { phase: seed.phase })}` : null}
      </div>
    </div>
  );
}
