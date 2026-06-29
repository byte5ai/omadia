'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

interface TableProps {
  children?: ReactNode;
  className?: string;
}

/**
 * Custom `<table>` renderer for {@link Markdown}. Wraps the GFM table in a
 * scroll-container so very wide / very long tables stay inside their
 * surrounding block: horizontal scroll for many columns or long
 * compound-word cells, vertical scroll with a sticky `<thead>` for many
 * rows. The wrapper is keyboard-focusable so arrow-key scrolling works
 * for keyboard-only users.
 */
export function MarkdownTable({
  children,
  className,
}: TableProps): React.ReactElement {
  const t = useTranslations('markdownTable');
  return (
    <div
      className="md-table-wrap"
      tabIndex={0}
      role="group"
      aria-label={t('scrollRegionLabel')}
    >
      <table className={className}>{children}</table>
    </div>
  );
}
