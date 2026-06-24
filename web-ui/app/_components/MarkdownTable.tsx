'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '../_lib/cn';

interface TableProps {
  children?: ReactNode;
  className?: string;
}

/**
 * Custom `<table>` renderer for {@link Markdown}. Wraps the GFM table in a
 * scroll-container so very wide / very long tables stay inside the chat
 * bubble: horizontal scroll for many columns or long compound-word cells,
 * vertical scroll with a sticky `<thead>` for many rows. A toolbar button
 * opens the table in a full-viewport modal for inspection.
 *
 * Streaming-safe: the table DOM is owned by React; the full-view modal
 * renders the same children in a body-portal overlay, so chat-bubble
 * ancestors with `transform`/`filter` can't re-anchor its `position: fixed`.
 */
export function MarkdownTable({
  children,
  className,
}: TableProps): React.ReactElement {
  const t = useTranslations('markdownTable');
  const [open, setOpen] = useState(false);

  const onOpen = useCallback(() => {
    setOpen(true);
  }, []);
  const onClose = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <div className="md-table-block relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('openFullView')}
        title={t('openFullView')}
        className={cn(
          'absolute right-1 top-1 z-[2] rounded p-1',
          'bg-[color:var(--bg-soft)]/90 text-[color:var(--fg-muted)]',
          'transition-colors hover:bg-[color:var(--bg-elevated)] hover:text-[color:var(--fg-strong)]',
        )}
      >
        <Maximize2 size={14} aria-hidden />
      </button>
      <div className="md-table-wrap">
        <table className={className}>{children}</table>
      </div>
      <TableFullViewModal open={open} onClose={onClose} className={className}>
        {children}
      </TableFullViewModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-view modal — body-portal so the `fixed` panel is always anchored to
// the viewport, regardless of chat-bubble ancestors that may have set
// `transform`/`filter`/`backdrop-filter` (which would otherwise turn the
// nearest such ancestor into the containing block for `position: fixed`).
// ---------------------------------------------------------------------------

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
}

function TableFullViewModal({
  open,
  onClose,
  children,
  className,
}: ModalProps): React.ReactElement | null {
  const t = useTranslations('markdownTable');
  // SSR has no `document` — defer portal creation until mounted to avoid a
  // hydration mismatch. Server renders null; client mounts → portal appears.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex flex-col bg-[color:var(--bg-elevated)] text-[color:var(--fg)]"
          role="dialog"
          aria-modal="true"
          aria-label={t('modalTitle')}
          initial="hidden"
          animate="shown"
          exit="hidden"
          variants={FADE_VARIANTS}
          transition={TRANSITION_FAST}
        >
          <header className="flex items-center justify-between gap-4 border-b border-[color:var(--border)] px-4 py-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              {t('modalTitle')}
            </h3>
            <button
              type="button"
              onClick={onClose}
              autoFocus
              aria-label={t('ariaClose')}
              className="rounded-full p-2 text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>

          <div className="md-view min-h-0 flex-1 overflow-hidden p-2">
            <div className="md-table-wrap md-table-wrap--full h-full">
              <table className={className}>{children}</table>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Motion variants — pure opacity fade. Avoids `transform` on the panel so
// nothing inside the fullscreen pane inherits a stacking-context that would
// re-anchor a hypothetical nested `position: fixed` child.
// ---------------------------------------------------------------------------

const EASE_OUT: [number, number, number, number] = [0.22, 0.61, 0.36, 1];
const TRANSITION_FAST = { duration: 0.14, ease: EASE_OUT };

const FADE_VARIANTS = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
};
