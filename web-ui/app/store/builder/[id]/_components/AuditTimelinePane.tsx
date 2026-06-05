'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

import { listBuilderAudit, type BuilderAuditEvent } from '../../../../_lib/api';

/**
 * Issue #57 — paginated audit timeline view.
 *
 * Renders the result of `GET /v1/builder/drafts/:id/audit` newest-first
 * with action-specific icons, action label, a mini-diff line from the
 * persisted `details_json`, and a relative timestamp. Pagination is
 * "Load more" — appends the next 30-row page on click.
 */

const PAGE_SIZE = 30;

type AuditT = ReturnType<typeof useTranslations<'builder.versions'>>;

const ACTION_LABEL_KEY: Readonly<Record<string, string>> = {
  persona_updated: 'actionPersonaUpdated',
  quality_updated: 'actionQualityUpdated',
  spec_patched: 'actionSpecPatched',
  slot_filled: 'actionSlotFilled',
};

const ACTION_ICON: Readonly<Record<string, string>> = {
  persona_updated: '🎭',
  quality_updated: '🛡',
  spec_patched: '🔧',
  slot_filled: '📝',
};

function relTime(ts: number, t: AuditT): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('relSecondsAgo');
  if (diff < 3_600_000) return t('relMinutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('relHoursAgo', { count: Math.floor(diff / 3_600_000) });
  return t('relDaysAgo', { count: Math.floor(diff / 86_400_000) });
}

function detailSummary(ev: BuilderAuditEvent, t: AuditT): string {
  const d = ev.details ?? {};
  switch (ev.action) {
    case 'persona_updated': {
      const axes = Array.isArray(d['axes']) ? (d['axes'] as string[]) : [];
      const template =
        typeof d['template'] === 'string' && d['template'] ? d['template'] : null;
      const parts: string[] = [];
      if (template) parts.push(t('detailTemplate', { template }));
      if (axes.length > 0) parts.push(t('detailAxes', { count: axes.length }));
      if (d['hasCustomNotes']) parts.push(t('detailCustomNotes'));
      return parts.join(' • ') || '—';
    }
    case 'quality_updated': {
      const parts: string[] = [];
      if (d['sycophancy'])
        parts.push(t('detailSycophancy', { value: String(d['sycophancy']) }));
      const presets = Array.isArray(d['presets']) ? (d['presets'] as string[]) : [];
      if (presets.length > 0) parts.push(t('detailPresets', { count: presets.length }));
      const c = typeof d['customCount'] === 'number' ? d['customCount'] : 0;
      if (c > 0) parts.push(t('detailCustom', { count: c }));
      return parts.join(' • ') || '—';
    }
    case 'spec_patched': {
      const ops = Array.isArray(d['ops']) ? d['ops'] : [];
      return t('detailOperations', { count: ops.length });
    }
    case 'slot_filled': {
      const slot = typeof d['slotKey'] === 'string' ? d['slotKey'] : '?';
      const bytes = typeof d['bytes'] === 'number' ? d['bytes'] : 0;
      return t('detailSlotBytes', { slot, bytes });
    }
    default:
      return '—';
  }
}

export interface AuditTimelinePaneProps {
  draftId: string;
}

export function AuditTimelinePane({ draftId }: AuditTimelinePaneProps): React.ReactElement {
  const t = useTranslations('builder.versions');
  const [events, setEvents] = useState<BuilderAuditEvent[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (off: number, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listBuilderAudit(draftId, { limit: PAGE_SIZE, offset: off });
        setTotal(page.total);
        setEvents((prev) => (append ? [...prev, ...page.events] : page.events));
        setOffset(off + page.events.length);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [draftId],
  );

  useEffect(() => {
    // Fetch-on-mount: loadPage() touches state only after the awaited
    // page fetch — no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPage(0, false);
  }, [loadPage]);

  const hasMore = events.length < total;

  return (
    <section data-testid="audit-timeline" className="space-y-2 p-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[color:var(--fg-strong)]">
          {t('historyHeading')}
        </h3>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {t('countOfTotal', { count: events.length, total })}
        </span>
      </header>

      {error && (
        <div role="alert" className="text-xs text-red-600" data-testid="audit-error">
          {error}
        </div>
      )}

      {events.length === 0 && !loading && (
        <div className="text-xs text-[color:var(--fg-muted)]" data-testid="audit-empty">
          {t('empty')}
        </div>
      )}

      <ul className="space-y-1" data-testid="audit-list">
        {events.map((ev) => {
          const labelKey = ACTION_LABEL_KEY[ev.action];
          return (
          <li
            key={ev.id}
            data-testid={`audit-event-${String(ev.id)}`}
            className="flex items-baseline gap-2 rounded border border-[color:var(--border)] px-2 py-1 text-sm"
          >
            <span aria-hidden>{ACTION_ICON[ev.action] ?? '•'}</span>
            <span className="font-medium">
              {labelKey ? t(labelKey) : ev.action}
            </span>
            <span className="text-xs text-[color:var(--fg-muted)]">
              {detailSummary(ev, t)}
            </span>
            <span className="ml-auto text-xs text-[color:var(--fg-subtle)]">
              {relTime(ev.createdAt, t)}
            </span>
          </li>
          );
        })}
      </ul>

      {hasMore && (
        <button
          type="button"
          data-testid="audit-load-more"
          onClick={() => {
            void loadPage(offset, true);
          }}
          disabled={loading}
          className="rounded border border-[color:var(--border)] px-3 py-1 text-xs"
        >
          {loading ? t('loading') : t('loadMore')}
        </button>
      )}
    </section>
  );
}
