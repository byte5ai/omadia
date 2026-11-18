'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Lock, Shield } from 'lucide-react';

import { cn } from '../../_lib/cn';
import {
  getInstalledPlugin,
  getPrivacyPosture,
  updateInstalledPluginConfig,
} from '../../_lib/api';
import { serverErrorMessage } from '../../_lib/apiErrorMessage';
import { Button } from '@/app/_components/ui/Button';

// ---------------------------------------------------------------------------
// PrivacyModePicker — Slice 2.5 quick-picker for the operator-owned
// `_privacy_mode` setting on an installed plugin. Reads the current value
// via GET /installed/:id and PATCHes back on change. Optimistic UI: the
// dropdown reflects the new value immediately, error state rolls back.
//
// #1510 — `per_tool` names its tools in `_privacy_bypass_scopes`. That key is
// synthetic (not a manifest setup field), so neither "Edit setup fields" nor
// the agent page shows it; the editor for it lives here, next to the mode.
//
// #1508 — with `OMADIA_PRIVACY_FORCE_GUARDED=true` every plugin runs guarded
// whatever is stored here. The picker then shows the org lock instead of
// offering a bypass that would have no effect.
//
// #1548 — any change that makes raw results of this plugin reach the LLM
// provider (mode → bypass, mode → per_tool with a stored tool list, or a list
// edit that adds tools) waits for an explicit confirm. Cancel keeps the stored
// value and sends no PATCH. Switching back to guarded needs no confirm.
// ---------------------------------------------------------------------------

type PrivacyMode = 'guarded' | 'bypass' | 'per_tool';

/** Message-key leaves under `store.install` — translated at render. */
const PRIVACY_MODE_LABEL_KEYS: Record<PrivacyMode, string> = {
  guarded: 'privacyGuarded',
  bypass: 'privacyBypass',
  per_tool: 'privacyPerTool',
};

function isPrivacyMode(v: unknown): v is PrivacyMode {
  return v === 'guarded' || v === 'bypass' || v === 'per_tool';
}

/** The stored scope list as the editor shows it. The middleware stores a
 *  `string[]`; an older install may still hold the comma-separated string. */
function scopesToText(stored: unknown): string {
  if (Array.isArray(stored)) {
    return stored.filter((s): s is string => typeof s === 'string').join(', ');
  }
  return typeof stored === 'string' ? stored : '';
}

/** Tool names in the editor text, split the way the middleware's
 *  `parseScopes` splits them (comma-separated, trimmed, empties dropped). */
function parseScopeText(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A change that starts sending raw results and waits for a confirm. */
type PendingBypass =
  | { kind: 'mode'; next: PrivacyMode; tools: string[] }
  | { kind: 'scopes'; tools: string[] };

function errorText(err: unknown): string {
  return serverErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
}

export function PrivacyModePicker({
  pluginId,
}: {
  pluginId: string;
}): React.ReactElement | null {
  const t = useTranslations('store.install');
  // `null` initial state → "loading". Once loaded we know what mode the
  // backend currently has stored (default 'guarded' when unset).
  const [mode, setMode] = useState<PrivacyMode | null>(null);
  const [scopes, setScopes] = useState('');
  const [savedScopes, setSavedScopes] = useState('');
  // Whether the org-wide clamp is on. A failed posture read leaves the picker
  // editable, as it was before #1508 — the dispatch hook enforces the clamp
  // either way, this only decides what the operator is told.
  const [forceGuarded, setForceGuarded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the GET succeeded at all — without it we render
  // nothing rather than a confusing dropdown over nothing.
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingBypass | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [entry, posture] = await Promise.allSettled([
        getInstalledPlugin(pluginId),
        getPrivacyPosture(),
      ]);
      if (cancelled) return;
      if (posture.status === 'fulfilled') {
        setForceGuarded(posture.value.force_guarded);
      }
      const config =
        entry.status === 'fulfilled' ? entry.value?.config : undefined;
      if (config) {
        const current = config['_privacy_mode'];
        setMode(isPrivacyMode(current) ? current : 'guarded');
        const text = scopesToText(config['_privacy_bypass_scopes']);
        setScopes(text);
        setSavedScopes(text);
      } else if (entry.status === 'rejected') {
        setError(errorText(entry.reason));
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  function requestChange(next: PrivacyMode): void {
    if (next === mode) return;
    if (next === 'bypass') {
      setPending({ kind: 'mode', next, tools: [] });
      return;
    }
    const storedTools = parseScopeText(savedScopes);
    // From bypass, a tool list only narrows what goes out raw: no confirm.
    if (next === 'per_tool' && storedTools.length > 0 && mode !== 'bypass') {
      setPending({ kind: 'mode', next, tools: storedTools });
      return;
    }
    void handleChange(next);
  }

  function requestSaveScopes(): void {
    const stored = new Set(parseScopeText(savedScopes));
    const added = parseScopeText(scopes).filter((tool) => !stored.has(tool));
    if (added.length > 0) {
      setPending({ kind: 'scopes', tools: added });
      return;
    }
    void saveScopes();
  }

  function confirmPending(): void {
    const current = pending;
    setPending(null);
    if (!current) return;
    if (current.kind === 'mode') void handleChange(current.next);
    else void saveScopes();
  }

  async function handleChange(next: PrivacyMode): Promise<void> {
    const previous = mode;
    setMode(next);
    setSaving(true);
    setError(null);
    try {
      await updateInstalledPluginConfig(pluginId, { _privacy_mode: next });
    } catch (err) {
      // Roll back to the previous value so the dropdown reflects what
      // the backend actually has stored.
      setMode(previous);
      setError(t('privacySaveFailed', { error: errorText(err) }));
    } finally {
      setSaving(false);
    }
  }

  async function saveScopes(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // The middleware parses the comma-separated text with the same
      // `parseScopes` the dispatch hook uses and stores the clean list.
      const res = await updateInstalledPluginConfig(pluginId, {
        _privacy_bypass_scopes: scopes,
      });
      const text = scopesToText(res.updated?.config['_privacy_bypass_scopes']);
      setScopes(text);
      setSavedScopes(text);
    } catch (err) {
      setError(t('privacySaveFailed', { error: errorText(err) }));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-3 py-3">
        <div className="flex items-center gap-2 text-[11px] text-[color:var(--fg-subtle)]">
          <span className="lume-busy-dots" aria-hidden />
          {t('privacyLoading')}
        </div>
      </div>
    );
  }
  if (mode === null) {
    return (
      <div className="rounded-md border border-[color:var(--danger,#b03030)]/40 bg-[color:var(--danger,#b03030)]/5 px-3 py-2">
        <p className="text-[12px] text-[color:var(--danger,#b03030)]">
          {error
            ? t('privacyLoadFailedWithError', { error })
            : t('privacyLoadFailed')}
        </p>
      </div>
    );
  }

  const tone =
    mode === 'bypass' && !forceGuarded
      ? 'border-[color:var(--warning)] bg-[color:var(--warning)]/10'
      : 'border-[color:var(--border)] bg-[color:var(--bg-soft)]';

  return (
    <div className={cn('rounded-md border px-3 py-3', tone)}>
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={`privacy-mode-${pluginId}`}
          className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]"
        >
          <Shield className="size-3.5" aria-hidden />
          {t('privacyModeLabel')}
        </label>
        {forceGuarded ? (
          <span
            data-testid="privacy-org-lock"
            className="inline-flex items-center gap-1 rounded-full bg-[color:var(--accent)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--accent)]"
          >
            <Lock className="size-3" aria-hidden />
            {t('privacyLockedBadge')}
          </span>
        ) : null}
      </div>
      <select
        id={`privacy-mode-${pluginId}`}
        value={
          forceGuarded
            ? 'guarded'
            : pending?.kind === 'mode'
              ? pending.next
              : mode
        }
        disabled={saving || forceGuarded || pending !== null}
        onChange={(e) => requestChange(e.target.value as PrivacyMode)}
        className={cn(
          'mt-2 w-full rounded border px-2 py-2 text-[13px]',
          'border-[color:var(--border)] bg-[color:var(--bg)]',
          'focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]',
          saving || forceGuarded ? 'opacity-60' : '',
        )}
      >
        {(
          Object.entries(PRIVACY_MODE_LABEL_KEYS) as Array<[PrivacyMode, string]>
        ).map(([value, labelKey]) => (
          <option key={value} value={value}>
            {t(labelKey)}
          </option>
        ))}
      </select>
      <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--fg-subtle)]">
        {forceGuarded
          ? t('privacyLockedHelp')
          : mode === 'guarded'
            ? t('privacyGuardedHelp')
            : mode === 'bypass'
              ? t('privacyBypassHelp')
              : t('privacyPerToolHelp')}
      </p>
      {forceGuarded && mode !== 'guarded' ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--fg-subtle)]">
          {t('privacyLockedStored', { mode: t(PRIVACY_MODE_LABEL_KEYS[mode]) })}
        </p>
      ) : null}
      {mode === 'per_tool' && !forceGuarded ? (
        <div className="mt-3">
          <label
            htmlFor={`privacy-scopes-${pluginId}`}
            className="text-[11px] font-semibold text-[color:var(--fg-muted)]"
          >
            {t('privacyScopesLabel')}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`privacy-scopes-${pluginId}`}
              type="text"
              value={scopes}
              disabled={saving || pending !== null}
              onChange={(e) => setScopes(e.target.value)}
              placeholder={t('privacyScopesPlaceholder')}
              className="font-mono-num min-w-0 flex-1 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={requestSaveScopes}
              disabled={saving || pending !== null || scopes === savedScopes}
            >
              {t('privacyScopesSave')}
            </Button>
          </div>
          {savedScopes.trim().length === 0 ? (
            <p className="mt-1 text-[11px] text-[color:var(--warning)]">
              {t('privacyScopesEmpty')}
            </p>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <div
          role="alertdialog"
          aria-labelledby={`privacy-confirm-${pluginId}`}
          data-testid="privacy-bypass-confirm"
          className="mt-3 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-3"
        >
          <p
            id={`privacy-confirm-${pluginId}`}
            className="flex items-start gap-2 text-[12px] leading-relaxed text-[color:var(--fg)]"
          >
            <AlertTriangle
              className="mt-0.5 size-3.5 shrink-0 text-[color:var(--warning)]"
              aria-hidden
            />
            <span>
              {pending.kind === 'mode' && pending.next === 'bypass'
                ? t('privacyConfirmBypass')
                : t('privacyConfirmTools', { tools: pending.tools.join(', ') })}
            </span>
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" pill size="sm" onClick={confirmPending}>
              {t('privacyConfirmYes')}
            </Button>
            <Button
              variant="secondary"
              pill
              size="sm"
              onClick={() => setPending(null)}
              className="font-semibold text-[color:var(--fg-muted)]"
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {saving && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-[color:var(--fg-subtle)]">
          <span className="lume-busy-dots" aria-hidden />
          {t('saving')}
        </div>
      )}
      {error && (
        <p className="font-mono-num mt-2 text-[11px] text-[color:var(--danger,#b03030)]">
          {error}
        </p>
      )}
    </div>
  );
}
