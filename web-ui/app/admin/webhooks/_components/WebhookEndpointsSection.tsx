'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpointDeliveries,
  listWebhookEndpoints,
  rotateWebhookEndpointSecret,
  setWebhookEndpointEnabled,
  type ConductorWebhookEndpoint,
  type ConductorWebhookInboundDelivery,
} from '@/app/_lib/api';

import { StatusBadge, card, inputCls, toFriendlyError } from './shared';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; endpoints: ConductorWebhookEndpoint[] }
  | { kind: 'error'; message: string };

/**
 * Issue #437 — inbound endpoints (`POST /api/hooks/:endpointId`). Minimal admin
 * view: create/enable-disable/rotate-secret/delete, plus per-endpoint delivery
 * history (the acceptance-criterion "visible in a delivery log (admin UI)").
 * A created/rotated secret is shown ONCE — the backend never returns it again.
 */
export function WebhookEndpointsSection(): React.ReactElement {
  const t = useTranslations('adminWebhooks.endpoints');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<ConductorWebhookInboundDelivery[]>([]);

  const [eventId, setEventId] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await listWebhookEndpoints();
      setState({ kind: 'ready', endpoints: res.endpoints });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const onCreate = useCallback(async (): Promise<void> => {
    if (!eventId.trim()) return;
    setActionError(null);
    setCreating(true);
    try {
      const { endpoint, secret } = await createWebhookEndpoint({
        eventId: eventId.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setEventId('');
      setDescription('');
      setRevealedSecret({ id: endpoint.endpointId, secret });
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setCreating(false);
    }
  }, [eventId, description, reload]);

  const onRotate = useCallback(async (endpointId: string): Promise<void> => {
    setActionError(null);
    setPending(endpointId);
    try {
      const { secret } = await rotateWebhookEndpointSecret(endpointId);
      setRevealedSecret({ id: endpointId, secret });
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setPending(null);
    }
  }, []);

  const onToggle = useCallback(
    async (endpointId: string, enabled: boolean): Promise<void> => {
      setActionError(null);
      setPending(endpointId);
      try {
        await setWebhookEndpointEnabled(endpointId, enabled);
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
    async (endpointId: string): Promise<void> => {
      if (!confirm(t('confirmDelete'))) return;
      setActionError(null);
      setPending(endpointId);
      try {
        await deleteWebhookEndpoint(endpointId);
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
    async (endpointId: string): Promise<void> => {
      if (expanded === endpointId) {
        setExpanded(null);
        return;
      }
      setExpanded(endpointId);
      try {
        const res = await listWebhookEndpointDeliveries(endpointId);
        setDeliveries(res.deliveries);
      } catch (err) {
        setActionError(toFriendlyError(err));
      }
    },
    [expanded],
  );

  const inboundUrl = (endpointId: string): string =>
    typeof window !== 'undefined' ? `${window.location.origin}/api/hooks/${endpointId}` : `/api/hooks/${endpointId}`;

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">{t('heading')}</h2>
      <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('hint')}</p>

      <div className={`${card} mb-4 flex flex-wrap items-end gap-3`}>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">{t('fields.eventId')}</span>
          <input className={inputCls} value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="orders.created" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">{t('fields.description')}</span>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <Button variant="primary" onClick={() => void onCreate()} disabled={!eventId.trim() || creating}>
          {creating ? '…' : t('create')}
        </Button>
      </div>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">{state.message}</p>
      ) : state.endpoints.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.endpoints.map((ep) => (
            <li key={ep.endpointId} className={card}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">{ep.eventId}</span>
                    <StatusBadge enabled={ep.enabled} />
                  </div>
                  <code className="text-[12px] text-[color:var(--fg-muted)]">{inboundUrl(ep.endpointId)}</code>
                  {ep.description && <span className="text-[13px] text-[color:var(--fg-muted)]">{ep.description}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onClick={() => void onToggleHistory(ep.endpointId)}>
                    {expanded === ep.endpointId ? t('hideHistory') : t('viewHistory')}
                  </Button>
                  <Button variant="secondary" onClick={() => void onToggle(ep.endpointId, !ep.enabled)} disabled={pending === ep.endpointId}>
                    {ep.enabled ? t('disable') : t('enable')}
                  </Button>
                  <Button variant="secondary" onClick={() => void onRotate(ep.endpointId)} busy={pending === ep.endpointId} busyLabel={t('rotating')}>
                    {t('rotateSecret')}
                  </Button>
                  <Button variant="danger" onClick={() => void onDelete(ep.endpointId)} busy={pending === ep.endpointId} busyLabel={t('deleting')}>
                    {t('delete')}
                  </Button>
                </div>
              </div>

              {revealedSecret?.id === ep.endpointId && (
                <div className="mt-3 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/5 p-3">
                  <p className="mb-1 text-[12px] font-semibold text-[color:var(--fg-strong)]">{t('secretRevealed')}</p>
                  <code className="block break-all text-[12px] text-[color:var(--fg-strong)]">{revealedSecret.secret}</code>
                  <Button variant="ghost" onClick={() => setRevealedSecret(null)}>
                    {t('dismiss')}
                  </Button>
                </div>
              )}

              {expanded === ep.endpointId && (
                <div className="mt-3 border-t border-[color:var(--border)] pt-3">
                  {deliveries.length === 0 ? (
                    <p className="text-[13px] text-[color:var(--fg-muted)]">{t('noDeliveries')}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[12px]">
                        <thead>
                          <tr className="text-[color:var(--fg-muted)]">
                            <th className="pb-1 pr-3">{t('table.deliveryId')}</th>
                            <th className="pb-1 pr-3">{t('table.outcome')}</th>
                            <th className="pb-1">{t('table.receivedAt')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deliveries.map((d) => (
                            <tr key={d.deliveryId} className="border-t border-[color:var(--border)]">
                              <td className="py-1 pr-3 font-mono">{d.deliveryId}</td>
                              <td className="py-1 pr-3">{d.outcome}</td>
                              <td className="py-1">{new Date(d.receivedAt).toLocaleString()}</td>
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
