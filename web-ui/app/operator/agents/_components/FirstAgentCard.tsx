'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { useBroadReachConfirm } from '@/app/_components/agents/useBroadReachConfirm';
import { ApiError } from '@/app/_lib/api';
import {
  createFirstAgent,
  getFirstRunOnboarding,
  type FirstRunOnboardingDto,
} from '../../../_lib/agents';
import { serverCode, useAgentApiErrorText } from './useAgentApiErrorText';

/** Refusals the operator answers by picking another name (the slug comes from it). */
const RENAME_CODES: ReadonlySet<string> = new Set(['slug_taken', 'slug_state_remains']);

/**
 * #2054 — spec 2042 §7 "Onboarding": a fresh installation starts with no
 * agent holding any capability; the first-run flow creates the first agent
 * with an explicit choice of capabilities. Nothing is preselected and none at
 * all is a valid choice. Shown while the middleware says the flow is due
 * (`GET /v1/operator/agents/onboarding`); gone once the first agent exists.
 */
export function FirstAgentCard(): React.ReactElement | null {
  const t = useTranslations('agentReach.firstRun');
  const router = useRouter();
  const broadReach = useBroadReachConfirm();
  const errorText = useAgentApiErrorText();
  const [offer, setOffer] = useState<FirstRunOnboardingDto | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFirstRunOnboarding()
      .then((res) => {
        if (!cancelled) setOffer(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOffer(null);
        // The runtime is down (503): the directory below says so. Anything
        // else is said here instead of hiding the first-run flow (#1880).
        if (!(err instanceof ApiError && err.status === 503)) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <p role="alert" className="text-[12px] text-[color:var(--danger)]">
        {t('loadFailed', { detail: loadError })}
      </p>
    );
  }
  if (!offer?.required) return null;

  const toggle = (id: string): void =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const created = await broadReach.guard(trimmed, (confirm) =>
        createFirstAgent(
          {
            name: trimmed,
            ...(description.trim() ? { description: description.trim() } : {}),
            plugin_ids: [...chosen],
          },
          { confirmBroadReach: confirm },
        ),
      );
      if (created) {
        setOffer({ ...offer, required: false });
        router.refresh();
      }
    } catch (err) {
      // The refusal in the reader's language (slug state, taken slug, bad
      // field); the name stays in the field so another one can be tried.
      const reason = errorText(err);
      const code = serverCode(err);
      const detail = code !== null && RENAME_CODES.has(code) ? `${reason} ${t('renameHint')}` : reason;
      setError(t('failed', { detail }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="first-agent-card"
      className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/5 p-4"
    >
      {broadReach.dialog}
      <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">{t('eyebrow')}</div>
      <h2 className="mt-2 text-lg font-semibold">{t('title')}</h2>
      <p className="mt-1 max-w-2xl text-sm text-[color:var(--fg-muted)]">{t('body')}</p>
      <form className="mt-4 space-y-3" onSubmit={(e) => void submit(e)}>
        <label className="block text-sm">
          <span className="block text-[color:var(--fg-muted)]">{t('nameLabel')}</span>
          <input
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full max-w-sm rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          <span className="block text-[color:var(--fg-muted)]">{t('descriptionLabel')}</span>
          <input
            type="text"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full max-w-xl rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1"
          />
        </label>
        <fieldset className="text-sm">
          <legend className="text-[color:var(--fg-muted)]">{t('capabilitiesLabel')}</legend>
          <p className="text-xs text-[color:var(--fg-muted)]">{t('capabilitiesHint')}</p>
          {offer.capabilities.length === 0 ? (
            <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('capabilitiesEmpty')}</p>
          ) : (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {offer.capabilities.map((c) => (
                <li key={c.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={chosen.has(c.id)}
                      disabled={busy}
                      onChange={() => toggle(c.id)}
                    />
                    <span>{c.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-[color:var(--danger)]">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
          {busy ? t('submitting') : t('submit')}
        </Button>
      </form>
    </section>
  );
}
