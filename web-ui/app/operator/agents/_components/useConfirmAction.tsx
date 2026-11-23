'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ConfirmDialog } from '@/app/_components/ConfirmDialog';

export interface ConfirmRequest {
  /** The question, as the native dialog asked it. */
  title: string;
  /** The label of the action being confirmed ("Delete"). */
  confirmLabel: string;
  onConfirm: () => void;
  /** Asks the operator to type this exact text before the action is offered
   *  (a slug). `prompt` is the sentence that says so. */
  typed?: { expected: string; prompt: string };
}

/**
 * Rollout defect D33 — the agent directory asked "really delete?" through the
 * browser's own `confirm()` and `prompt()`. Those block the page, cannot be
 * styled or driven by a test tool, and look like nothing else in the app.
 *
 * `ask(request)` opens the app's dialog for one action; render `dialog` once
 * in the component. One action at a time: asking again replaces the question.
 */
export function useConfirmAction(): { ask: (request: ConfirmRequest) => void; dialog: React.ReactElement } {
  const t = useTranslations('operatorAgents.confirmAction');
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [typed, setTyped] = useState('');

  const ask = useCallback((next: ConfirmRequest): void => {
    setTyped('');
    setRequest(next);
  }, []);
  const close = (): void => setRequest(null);
  const matches = request?.typed === undefined || typed.trim() === request.typed.expected;

  const dialog = (
    <ConfirmDialog
      open={request !== null}
      tone="danger"
      title={request?.title ?? ''}
      confirmLabel={request?.confirmLabel ?? ''}
      cancelLabel={t('cancel')}
      confirmDisabled={!matches}
      onConfirm={() => {
        if (!request || !matches) return;
        const { onConfirm } = request;
        close();
        onConfirm();
      }}
      onCancel={close}
    >
      {request?.typed ? (
        <label className="mt-2 block text-sm">
          <span className="block">{request.typed.prompt}</span>
          <input
            type="text"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            className="mt-2 w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono text-sm"
          />
          {typed.trim().length > 0 && !matches ? (
            <span className="mt-1 block text-xs text-[color:var(--danger)]">{t('typedMismatch')}</span>
          ) : null}
        </label>
      ) : null}
    </ConfirmDialog>
  );
  return { ask, dialog };
}
