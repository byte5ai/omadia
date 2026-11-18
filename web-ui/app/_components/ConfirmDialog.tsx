'use client';

import { useEffect, useId, useRef } from 'react';

import { Button } from './ui/Button';

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
  /** Extra content below `body` (lists, breakdowns). */
  children?: React.ReactNode;
  /** In flight: the confirm button shows `busyLabel`, both buttons and
   *  Escape are inert. */
  busy?: boolean;
  busyLabel?: string;
  confirmDisabled?: boolean;
  /** A wider panel for dialogs with lists. */
  wide?: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside the panel. */
function trapTab(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'Tab') return;
  const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (nodes.length === 0) return;
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) {
    e.preventDefault();
    first.focus();
  }
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
  children,
  busy = false,
  busyLabel,
  confirmDisabled = false,
  wide = false,
}: ConfirmDialogProps): React.ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // §7.5: focus opens on Cancel — deliberate friction before an
    // external-effect action. Enter therefore cancels by default; confirming
    // requires an explicit Tab or click.
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onCancel, busy]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      onKeyDown={trapTab}
    >
      <div
        className={`flex max-h-[90vh] w-full flex-col overflow-y-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-lg ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <h2
          id={titleId}
          className="text-base font-semibold text-[color:var(--fg-strong)]"
        >
          {title}
        </h2>
        {body && (
          <p className="mt-2 text-sm text-[color:var(--fg-muted)]">
            {body}
          </p>
        )}
        {children}
        <div className="mt-4 flex justify-end gap-2">
          {/* §7.5: focus opens on Cancel (deliberate friction). */}
          <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={confirmDisabled || busy}
            busy={busy}
            {...(busyLabel !== undefined ? { busyLabel } : {})}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
