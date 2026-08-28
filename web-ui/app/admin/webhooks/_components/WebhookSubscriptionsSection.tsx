'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptionDeliveries,
  listWebhookSubscriptions,
  rotateWebhookSubscriptionSecret,
  setWebhookSubscriptionEnabled,
  type ConductorWebhookOutboundDelivery,
  type ConductorWebhookSubscription,
} from '@/app/_lib/api';

import { StatusBadge, card, inputCls, toFriendlyError } from './shared';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; subscriptions: ConductorWebhookSubscription[] }
  | { kind: 'error'; message: string };

/**
 * Issue #437 — outbound subscriptions (an operator URL that receives an
 * HMAC-signed delivery on `run.completed` / `run.failed`). Minimal admin view:
 * create/enable-disable/rotate-secret/delete, plus per-subscription delivery
 * log with retry status — the acceptance-criterion "failed outbound deliveries
 * retry with backoff and are visible in a delivery log (admin UI)".
 */
export function WebhookSubscriptionsSection(): React.ReactElement {
  const t = useTranslations('adminWebhooks.subscriptions');
  const format = useFormatter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<ConductorWebhookOutboundDelivery[]>([]);

  const [url, setUrl] = useState('');
  const [event, setEvent] = useState('run.completed');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await listWebhookSubscriptions();
      setState({ kind: 'ready', subscriptions: res.subscriptions });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const onCreate = useCallback(async (): Promise<void> => {
    if (!url.trim() || !event.trim()) return;
    setActionError(null);
    setCreating(true);
    try {
      const { subscription, secret } = await createWebhookSubscription({
        url: url.trim(),
        event: event.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setUrl('');
      setDescription('');
      setRevealedSecret({ id: subscription.id, secret });
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setCreating(false);
    }
  }, [url, event, description, reload]);

  const onRotate = useCallback(async (id: string): Promise<void> => {
    setActionError(null);
    setPending(id);
    try {
      const { secret } = await rotateWebhookSubscriptionSecret(id);
      setRevealedSecret({ id, secret });
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setPending(null);
    }
  }, []);

  const onToggle = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      setActionError(null);
      setPending(id);
      try {
        await setWebhookSubscriptionEnabled(id, enabled);
        await reload();
      } catch (err) {
        setActionError(toFriendlyError(err));
      } finally {
        setPending(null);
      }
    },
    [reload],
  );

  const onDelete = useCallback(
    async (id: string): Promise<void> => {
      if (!confirm(t('confirmDelete'))) return;
      setActionError(null);
      setPending(id);
      try {
        await deleteWebhookSubscription(id);
        await reload();
      } catch (err) {
        setActionError(toFriendlyError(err));
      } finally {
        setPending(null);
      }
    },
    [reload, t],
  );

  const onToggleHistory = useCallback(
    async (id: string): Promise<void> => {
      if (expanded === id) {
        setExpanded(null);
        return;
      }
      setExpanded(id);
      try {
        const res = await listWebhookSubscriptionDeliveries(id);
        setDeliveries(res.deliveries);
      } catch (err) {
        setActionError(toFriendlyError(err));
      }
    },
    [expanded],
  );

  return (
    <section>
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">{t('heading')}</h2>
      <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('hint')}</p>

      <div className={`${card} mb-4 flex flex-wrap items-end gap-3`}>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">{t('fields.url')}</span>
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hook" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">{t('fields.event')}</span>
          <select className={inputCls} value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="run.completed">run.completed</option>
            <option value="run.failed">run.failed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">{t('fields.description')}</span>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <Button variant="primary" onClick={() => void onCreate()} disabled={!url.trim() || creating}>
          {creating ? '…' : t('create')}
        </Button>
      </div>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">{state.message}</p>
      ) : state.subscriptions.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.subscriptions.map((sub) => (
            <li key={sub.id} className={card}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">{sub.event}</span>
                    <StatusBadge enabled={sub.enabled} />
                  </div>
                  <code className="text-[12px] text-[color:var(--fg-muted)]">{sub.url}</code>
                  {sub.description && <span className="text-[13px] text-[color:var(--fg-muted)]">{sub.description}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onClick={() => void onToggleHistory(sub.id)}>
                    {expanded === sub.id ? t('hideHistory') : t('viewHistory')}
                  </Button>
                  <Button variant="secondary" onClick={() => void onToggle(sub.id, !sub.enabled)} disabled={pending === sub.id}>
                    {sub.enabled ? t('disable') : t('enable')}
                  </Button>
                  <Button variant="secondary" onClick={() => void onRotate(sub.id)} busy={pending === sub.id} busyLabel={t('rotating')}>
                    {t('rotateSecret')}
                  </Button>
                  <Button variant="danger" onClick={() => void onDelete(sub.id)} busy={pending === sub.id} busyLabel={t('deleting')}>
                    {t('delete')}
                  </Button>
                </div>
              </div>

              {revealedSecret?.id === sub.id && (
                <div className="mt-3 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/5 p-3">
                  <p className="mb-1 text-[12px] font-semibold text-[color:var(--fg-strong)]">{t('secretRevealed')}</p>
                  <code className="block break-all text-[12px] text-[color:var(--fg-strong)]">{revealedSecret.secret}</code>
                  <Button variant="ghost" onClick={() => setRevealedSecret(null)}>
                    {t('dismiss')}
                  </Button>
                </div>
              )}

              {expanded === sub.id && (
                <div className="mt-3 border-t border-[color:var(--border)] pt-3">
                  {deliveries.length === 0 ? (
                    <p className="text-[13px] text-[color:var(--fg-muted)]">{t('noDeliveries')}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[12px]">
                        <thead>
                          <tr className="text-[color:var(--fg-muted)]">
                            <th className="pb-1 pr-3">{t('table.status')}</th>
                            <th className="pb-1 pr-3">{t('table.attempts')}</th>
                            <th className="pb-1 pr-3">{t('table.lastError')}</th>
                            <th className="pb-1 pr-3">{t('table.nextAttemptAt')}</th>
                            <th className="pb-1">{t('table.createdAt')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deliveries.map((d) => (
                            <tr key={d.id} className="border-t border-[color:var(--border)]">
                              <td className="py-1 pr-3">{d.status}</td>
                              <td className="py-1 pr-3">{d.attempts}</td>
                              <td className="py-1 pr-3">{d.lastError ?? '—'}</td>
                              <td className="py-1 pr-3">{d.status === 'pending' ? format.dateTime(new Date(d.nextAttemptAt)) : '—'}</td>
                              <td className="py-1">{format.dateTime(new Date(d.createdAt))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {actionError && <p className="mt-4 text-sm text-[color:var(--danger)]">{actionError}</p>}
    </section>
  );
}
