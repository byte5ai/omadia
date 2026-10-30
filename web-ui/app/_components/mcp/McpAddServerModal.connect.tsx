'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  discoverMcpTools,
  getMcpAuthStatus,
  setMcpServerStatus,
  type McpServerNode,
} from '@/app/_lib/agentBuilder';

import { McpAuthSection } from './McpAuthSection';
import {
  classifyDiscoveryIssue,
  type McpDiscoveryIssue,
  useMcpAddErrorText,
} from './McpAddServerModal.errors';

const SLOW_DISCOVERY_MS = 15_000;

interface ConnectStepProps {
  server: McpServerNode;
  onServerChange: (server: McpServerNode) => void;
  onDiscovered: (server: McpServerNode) => void;
  onBack: () => void;
}

export function McpAddConnectStep({ server, onServerChange, onDiscovered, onBack }: ConnectStepProps): React.ReactElement {
  const t = useTranslations('adminMcp');
  const errorText = useMcpAddErrorText();
  const mountedRef = useRef(true);
  const autoRunRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const discoveryBusyRef = useRef(false);
  const authPollBusyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // Discovery against an unreachable host can sit on the server's connect timeout for a long
  // time with no feedback; after SLOW_DISCOVERY_MS the step says so and points at the endpoint.
  const [slow, setSlow] = useState(false);
  const [issue, setIssue] = useState<McpDiscoveryIssue | null>(null);
  // Token present but the server still refuses discovery → the endpoint is the usual culprit
  // (live finding 2026-10-30: Pleo answers 403 on `/`, the MCP endpoint is `/mcp`). Without
  // this the step just repeats "sign in" although the operator is already authorized.
  const [authorizedButRefused, setAuthorizedButRefused] = useState(false);
  const [authPollError, setAuthPollError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Only the mounted flag — NOT the attempt counter. React's dev StrictMode runs this
      // cleanup once right after the first mount; bumping the counter there made the
      // already-running discovery look stale, so its result (and `setBusy(false)`) were
      // dropped and the step spun forever (live finding 2026-10-30, 502 "Invalid URL" in 60 ms
      // never reached the UI). Superseded attempts are still fenced by `attemptRef` at run start.
      mountedRef.current = false;
    };
  }, []);

  const runDiscovery = useCallback(async (): Promise<void> => {
    if (discoveryBusyRef.current) return;
    discoveryBusyRef.current = true;
    const attempt = ++attemptRef.current;
    setBusy(true);
    setIssue(null);
    setAuthPollError(null);
    try {
      let activeServer = server;
      if (activeServer.status !== 'enabled') {
        activeServer = await setMcpServerStatus(activeServer.id, 'enabled');
        if (mountedRef.current && attemptRef.current === attempt) onServerChange(activeServer);
      }
      const discovered = await discoverMcpTools(activeServer.id);
      if (mountedRef.current && attemptRef.current === attempt) onDiscovered(discovered);
    } catch (err) {
      if (mountedRef.current && attemptRef.current === attempt) {
        const classified = classifyDiscoveryIssue(err) ?? { kind: 'error', text: errorText(err) };
        setIssue(classified);
        if (classified.kind === 'needs-auth') {
          const status = await getMcpAuthStatus(server.id).catch(() => null);
          if (mountedRef.current && attemptRef.current === attempt) setAuthorizedButRefused(status?.connected === true);
        } else {
          setAuthorizedButRefused(false);
        }
      }
    } finally {
      discoveryBusyRef.current = false;
      if (mountedRef.current && attemptRef.current === attempt) setBusy(false);
    }
  }, [errorText, onDiscovered, onServerChange, server]);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_DISCOVERY_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    if (autoRunRef.current === server.id) return;
    autoRunRef.current = server.id;
    void runDiscovery();
  }, [runDiscovery, server.id]);

  useEffect(() => {
    if (issue?.kind !== 'needs-auth') return;
    let cancelled = false;
    const onFocus = (): void => {
      if (authPollBusyRef.current || discoveryBusyRef.current) return;
      authPollBusyRef.current = true;
      setAuthPollError(null);
      void getMcpAuthStatus(server.id)
        .then((status) => {
          if (!cancelled && mountedRef.current && status.connected) return runDiscovery();
          return undefined;
        })
        .catch((err: unknown) => {
          if (!cancelled && mountedRef.current) setAuthPollError(errorText(err));
        })
        .finally(() => {
          authPollBusyRef.current = false;
        });
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [errorText, issue?.kind, runDiscovery, server.id]);

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-sm text-[color:var(--fg-muted)]">{t('addModal.connect.server', { name: server.name })}</p>
      {busy ? <p className="text-sm text-[color:var(--fg-muted)]" aria-busy="true">{t('addModal.connect.busy')}</p> : null}
      {busy && slow ? <p data-testid="mcp-add-slow" className="text-sm text-[color:var(--warning)]">{t('addModal.connect.slow', { endpoint: server.endpoint ?? '—' })}</p> : null}
      {issue?.kind === 'needs-auth' ? <McpAuthSection serverId={server.id} showDelegation={false} /> : null}
      {issue ? <ConnectIssueView issue={issue} serverId={server.id} /> : null}
      {issue?.kind === 'needs-auth' && authorizedButRefused ? <p data-testid="mcp-add-authorized-refused" className="text-sm text-[color:var(--warning)]">{t('addModal.connect.authorizedButRefused', { endpoint: server.endpoint ?? '—' })}</p> : null}
      {authPollError ? <p data-testid="mcp-add-connect-error" className="text-sm text-[color:var(--danger)]">{authPollError}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>{t('addModal.back')}</Button>
        {issue ? <Button data-testid="mcp-add-retry" variant="secondary" size="sm" busy={busy} busyLabel={t('addModal.connect.retrying')} onClick={() => void runDiscovery()}>{t('addModal.connect.retry')}</Button> : null}
      </div>
    </div>
  );
}

function ConnectIssueView({ issue, serverId }: { issue: McpDiscoveryIssue; serverId: string }): React.ReactElement | null {
  const t = useTranslations('adminMcp');
  if (issue.kind === 'needs-auth') {
    return <p data-testid="mcp-add-connect-error" className="text-sm text-[color:var(--fg-muted)]">{t('addModal.connect.needsAuth')}</p>;
  }
  if (issue.kind === 'error') {
    return <p data-testid="mcp-add-connect-error" className="text-sm text-[color:var(--danger)]">{issue.text}</p>;
  }
  const values = issue.kind === 'config-required' ? issue.missing : issue.placeholders;
  const detail = values.length > 0 ? values.join(', ') : t('addModal.connect.detailsUnknown');
  const message = issue.kind === 'config-required'
    ? t('addModal.connect.configRequired', { fields: detail })
    : t('addModal.connect.endpointPlaceholder', { placeholders: detail });
  return (
    <div data-testid="mcp-add-connect-error" className="rounded-md border border-[color:var(--warning)]/50 p-3 text-sm">
      <p className="text-[color:var(--fg-muted)]">{message}</p>
      <Link data-testid="mcp-add-config-link" href={`/admin/mcp?server=${encodeURIComponent(serverId)}`} className="mt-2 inline-block text-[color:var(--accent)] underline">{t('addModal.connect.configure')}</Link>
    </div>
  );
}
