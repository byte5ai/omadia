'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  authorizeMcpServer,
  disconnectMcpServer,
  getMcpAuthStatus,
  setMcpOAuthClient,
  type McpAuthStatus,
} from '@/app/_lib/agentBuilder';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * MCP OAuth connect widget (epic #459 W9). Self-contained connect/disconnect
 * flow for a single MCP server: shows connection status, a "Connect" button
 * that opens the provider login (or an inline client-registration form when the
 * issuer delegates OAuth and needs a one-time app), and a disconnect action.
 *
 * Extracted from the MCP Control Center so the chat's auth-required card can
 * reuse the exact same flow inside a modal — one source of truth for connecting
 * an MCP server, whether from admin or from the chat.
 */
export function McpAuthSection({
  serverId,
}: {
  serverId: string;
}): React.ReactElement | null {
  const t = useTranslations('adminMcp');
  const [status, setStatus] = useState<McpAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showClientForm, setShowClientForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // The OAuth authorize URL, once the flow has started. We render it as a
  // user-clickable link rather than auto-opening it: window.open() called after
  // an await chain is not treated as a user gesture and gets popup-blocked.
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getMcpAuthStatus(serverId));
    } catch (err) {
      setError(errText(err));
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While an authorize link is pending, re-check status when the user returns to
  // this tab (they just finished login in the provider tab → the callback stored
  // a token). Once connected, the link block hides via the render guard below.
  const connected = status?.connected ?? false;
  useEffect(() => {
    if (!authorizeUrl || connected) return;
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [authorizeUrl, connected, refresh]);

  if (!status || !status.protected) return null;

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await authorizeMcpServer(serverId);
      if (r.needsClient) {
        setShowClientForm(true);
      } else if (r.authorizeUrl) {
        // Surface the URL as a link the user clicks (fresh gesture opens it
        // reliably); auto-window.open here would be popup-blocked.
        setAuthorizeUrl(r.authorizeUrl);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveClient(): Promise<void> {
    if (!status?.issuer || clientId.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await setMcpOAuthClient(status.issuer, clientId.trim(), clientSecret.trim());
      setShowClientForm(false);
      setClientId('');
      setClientSecret('');
      await refresh();
      await connect();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/8 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">
          {status.connected ? (
            <span className="text-[color:var(--success)]">{t('auth.connected')}</span>
          ) : (
            <span className="text-[color:var(--warning)]">{t('auth.notConnected')}</span>
          )}
        </span>
        {status.connected ? (
          <Button
            size="sm"
            variant="ghost"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void disconnectMcpServer(serverId)
                .then(refresh)
                .catch((err: unknown) => setError(errText(err)))
                .finally(() => setBusy(false));
            }}
          >
            {t('auth.disconnect')}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" busy={busy} onClick={() => void connect()}>
            {t('auth.connect')}
          </Button>
        )}
      </div>
      {!status.connected ? (
        <div className="text-[11px] text-[color:var(--fg-muted)]">
          {status.brokered
            ? t('auth.hintBrokered')
            : t('auth.hintDelegated', { host: status.issuerHost ?? status.issuer ?? '?' })}
        </div>
      ) : null}
      {showClientForm ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 p-2.5">
          <div className="text-xs text-[color:var(--fg-muted)]">
            {t('auth.needsClientWhy', { host: status.issuerHost ?? status.issuer ?? '?' })}
          </div>
          {status.redirectUri ? (
            <div className="text-[11px] text-[color:var(--fg-muted)]">
              {t('auth.redirectUri')}:{' '}
              <code className="rounded bg-[color:var(--card)] px-1 py-0.5">{status.redirectUri}</code>
            </div>
          ) : null}
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t('auth.clientId')}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-[color:var(--accent)]"
          />
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={t('auth.clientSecret')}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-[color:var(--accent)]"
          />
          <div>
            <Button size="sm" busy={busy} onClick={() => void saveClient()}>
              {t('auth.saveClientAndConnect')}
            </Button>
          </div>
        </div>
      ) : null}
      {authorizeUrl && !status.connected ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/10 p-2.5">
          <div className="text-xs text-[color:var(--fg-default)]">
            {t('auth.readyToLogin', { host: status.issuerHost ?? status.issuer ?? '?' })}
          </div>
          <a
            href={authorizeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1 rounded-md bg-[color:var(--accent)] px-2.5 py-1.5 text-xs font-medium text-[color:var(--fg-on-dark)] hover:opacity-90"
          >
            {t('auth.continueLogin', { host: status.issuerHost ?? status.issuer ?? '?' })}
          </a>
          <div className="text-[11px] text-[color:var(--fg-muted)]">
            {t('auth.afterLoginHint')}
          </div>
          <div>
            <Button size="sm" variant="ghost" busy={busy} onClick={() => void refresh()}>
              {t('auth.checkStatus')}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <div className="text-xs text-[color:var(--danger)]">{error}</div> : null}
    </div>
  );
}
