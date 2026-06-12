'use client';

import { ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

interface PagePreviewFrameProps {
  draftId: string;
  routeId: string;
  /** Display in the title strip. Falls back to routeId. */
  label?: string;
}

/**
 * B.12-Followup B — Live-Preview iframe für eine ui_route. Lädt den
 * Workspace-internen Endpoint, der die gecapturete plugin-route über
 * einen temp-probe-server proxied. Status-Banner zeigt 503 (cold),
 * 404 (route missing) und 502 (capture missing) verständlich an.
 *
 * Pattern:
 *   - Bei Mount + manual Refresh-Click: increment iframe-key → React
 *     remounts → fresh GET. Browser-cache wird via cache-busting-query
 *     bypassed (?v=<counter>).
 *   - Pre-flight HEAD-check spart das iframe-blank-Flash: wir machen
 *     ein leises GET, lesen Status, und blenden Banner statt iframe
 *     bei 4xx/5xx ein.
 */
export function PagePreviewFrame({
  draftId,
  routeId,
  label,
}: PagePreviewFrameProps): React.ReactElement {
  const t = useTranslations('builder.uiSurfaces.preview');
  const [iframeKey, setIframeKey] = useState(0);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<AbortController | null>(null);

  const previewUrl = `/bot-api/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/ui-route/${encodeURIComponent(routeId)}?v=${String(iframeKey)}`;

  const probe = useCallback(async () => {
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(previewUrl, { signal: ac.signal });
      if (!res.ok) {
        let body: { code?: string; message?: string } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          // not JSON
        }
        setError({
          code: body.code ?? `http_${String(res.status)}`,
          message:
            body.message ??
            `Preview returned HTTP ${String(res.status)} (no detail).`,
        });
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError({
        code: 'fetch_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [previewUrl]);

  useEffect(() => {
    // Probe-on-mount: probe() touches state only after the awaited fetch —
    // no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void probe();
    return () => {
      inFlight.current?.abort();
    };
  }, [probe]);

  const onRefresh = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  return (
    <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--bg-subtle)] px-3 py-2 text-[11px]">
        <span className="font-medium text-[color:var(--fg-strong)]">
          {t('title')}
        </span>
        <span className="text-[color:var(--fg-muted)]">
          {label ?? routeId}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          {loading ? (
            <span className="text-[color:var(--fg-muted)]">{t('loading')}</span>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded p-1 text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--fg-strong)]"
            aria-label={t('refreshAriaLabel')}
            title={t('refreshTitle')}
          >
            <RefreshCw className="size-3" />
          </button>
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded p-1 text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--fg-strong)]"
            aria-label={t('openInNewTabAriaLabel')}
            title={t('openInNewTabTitle')}
          >
            <ExternalLink className="size-3" />
          </a>
        </span>
      </div>
      {error ? (
        <PreviewErrorBanner code={error.code} message={error.message} />
      ) : (
        <iframe
          key={iframeKey}
          src={previewUrl}
          title={t('iframeTitle', { label: label ?? routeId })}
          className="h-[480px] w-full border-0 bg-[color:var(--bg-elevated)]"
          sandbox="allow-scripts allow-same-origin"
        />
      )}
    </div>
  );
}

function PreviewErrorBanner({
  code,
  message,
}: {
  code: string;
  message: string;
}): React.ReactElement {
  const t = useTranslations('builder.uiSurfaces.preview');
  const hintKey = HINT_KEYS[code];
  const hint = hintKey ? t(hintKey) : undefined;
  return (
    <div className="bg-[color:var(--warning)]/10 px-4 py-6 text-[12px] text-[color:var(--warning)]">
      <div className="mb-1 font-semibold">{t('unavailableTitle')}</div>
      <code className="block break-words text-[11px] text-[color:var(--warning)]/80">
        {code}: {message}
      </code>
      {hint ? (
        <p className="mt-2 text-[11px] text-[color:var(--warning)]/90">
          {t.rich('hintLine', {
            strong: (chunks) => <strong>{chunks}</strong>,
            hint,
          })}
        </p>
      ) : null}
    </div>
  );
}

// Maps server-side error codes to translation keys under
// `builder.uiSurfaces.preview.hints.*`. Codes themselves are technical
// tokens and stay verbatim.
const HINT_KEYS: Record<string, string> = {
  'builder.preview_cold': 'hints.previewCold',
  'builder.ui_route_not_found': 'hints.uiRouteNotFound',
  'builder.preview_capture_missing': 'hints.previewCaptureMissing',
  'builder.preview_proxy_failed': 'hints.previewProxyFailed',
  fetch_failed: 'hints.fetchFailed',
};
