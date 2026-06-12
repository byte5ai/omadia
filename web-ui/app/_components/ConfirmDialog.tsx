'use client';

import { useEffect, useRef } from 'react';

/**
 * Minimal modal-confirm. No portal, no library — just a fixed-position
 * overlay with focus-trap basics. We keep it generic (title/body/labels)
 * so the same component covers chat-reset, destructive delete, and any
 * future "are you sure?" gates.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` paints the confirm button red. */
  tone?: 'neutral' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'neutral',
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement | null {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Auto-focus the confirm button so Enter commits.
    confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const confirmCls =
    tone === 'danger'
      ? 'bg-[color:var(--danger)] hover:bg-[color:var(--danger)] text-[color:var(--fg-on-dark)] border-[color:var(--danger-edge)]'
      : 'bg-[color:var(--bg-inverse)] hover:bg-[color:var(--fg-muted)] text-[color:var(--fg-on-dark)] border-[color:var(--border-strong)]';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-5 shadow-xl">
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold text-[color:var(--fg-strong)]"
        >
          {title}
        </h2>
        {body && (
          <p className="mt-2 text-sm text-[color:var(--fg-muted)]">
            {body}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-1.5 text-sm font-medium text-[color:var(--fg)] transition hover:border-[color:var(--border-strong)]"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded border px-4 py-1.5 text-sm font-medium transition ${confirmCls}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
