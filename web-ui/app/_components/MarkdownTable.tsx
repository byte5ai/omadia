'use client';

import type { ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
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
 *
 * The scroll-region affordance (focusable + labelled group) is only applied
 * when the wrapper actually overflows, so a table that fits its container
 * doesn't consume a tab stop or announce a redundant group (WCAG 2.1.1).
 */
export function MarkdownTable({
  children,
  className,
}: TableProps): React.ReactElement {
  const t = useTranslations('markdownTable');
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void =>
      setOverflows(
        el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="md-table-wrap"
      tabIndex={overflows ? 0 : undefined}
      role={overflows ? 'group' : undefined}
      aria-label={overflows ? t('scrollRegionLabel') : undefined}
    >
      <table className={className}>{children}</table>
    </div>
  );
}
