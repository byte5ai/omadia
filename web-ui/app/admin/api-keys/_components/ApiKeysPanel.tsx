'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyPublicView,
} from '@/app/_lib/api';

import { KeyStatusBadge, card, chipCls, inputCls, toFriendlyError } from './shared';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; keys: ApiKeyPublicView[] }
  | { kind: 'error'; message: string };

/**
 * The only real scope today (issue #439). Kept as a single hardcoded
 * checkbox rather than a generic scope picker — there is nothing else valid
 * to pick from yet. Not read from a backend catalog endpoint because none
 * exists; if a second scope ships, this is the one place to widen (ideally
 * to a list driven by a real catalog at that point, not a second hardcode).
 */
const CHAT_WRITE_SCOPE = 'chat:write';

const MIN_RATE_LIMIT = 1;
const MAX_RATE_LIMIT = 6000;
const DEFAULT_RATE_LIMIT_HINT = 60;

function parseRateLimitInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

export function ApiKeysPanel(): React.ReactElement {
  const t = useTranslations('adminApiKeys');

  const [state, setState] = useState<State>({ kind: 'loading' });

  // Create form.
  const [label, setLabel] = useState('');
  const [rateLimitInput, setRateLimitInput] = useState('');
  const [grantChatWrite, setGrantChatWrite] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Reveal-once token, set only by a successful create. Cleared by an
  // explicit dismiss — never auto-hidden, never re-derived from a fetch (the
  // list endpoint never returns a token field, so there is nothing to leak
  // even if this state were repopulated from a reload).
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Revoke flow.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await listApiKeys();
      setState({ kind: 'ready', keys: res.keys });
    } catch (err) {
      setState({ kind: 'error', message: toFriendlyError(err) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const rateLimitValue = useMemo(() => parseRateLimitInput(rateLimitInput), [rateLimitInput]);
  const rateLimitInvalid =
    rateLimitInput.trim() !== '' &&
    (rateLimitValue === undefined || rateLimitValue < MIN_RATE_LIMIT || rateLimitValue > MAX_RATE_LIMIT);

  // A key with zero scopes is a credential that authenticates and can do
  // nothing — not a useful thing to mint, and the backend rejects an
  // explicit `scopes: []` outright (see CreateApiKeyInput doc comment).
  // Blocking submission here keeps that a clear, explained dead end instead
  // of a 400 the operator has to decode.
  const canSubmit = grantChatWrite && !rateLimitInvalid && !creating;

  const onCreate = useCallback(async (): Promise<void> => {
    if (!canSubmit) return;
    setCreateError(null);
    setCreating(true);
    try {
      const created = await createApiKey({
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(rateLimitValue !== undefined ? { rateLimitPerMinute: rateLimitValue } : {}),
        // Sent explicitly (never omitted) so the request always reflects
        // exactly what the checkbox shows — omitting would coincidentally
        // resolve to the same legacy default today, but that's an
        // implementation detail of the backend this UI shouldn't lean on.
        scopes: [CHAT_WRITE_SCOPE],
      });
      setLabel('');
      setRateLimitInput('');
      setCopyState('idle');
      setRevealed({ id: created.key.id, token: created.token });
      await reload();
    } catch (err) {
      setCreateError(toFriendlyError(err));
    } finally {
      setCreating(false);
    }
  }, [canSubmit, label, rateLimitValue, reload]);

  const onCopyToken = useCallback(async (): Promise<void> => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.token);
      setCopyState('copied');
    } catch {
      // Clipboard API can fail (permissions, insecure context). The token
      // stays visible and selectable — this is a soft failure, not an error
      // banner: the operator can still copy it manually.
      setCopyState('failed');
    }
  }, [revealed]);

  const onDismissRevealed = useCallback((): void => {
    setRevealed(null);
    setCopyState('idle');
  }, []);

  const onConfirmRevoke = useCallback(
    async (id: string): Promise<void> => {
      setActionError(null);
      setPendingId(id);
      try {
        const { key } = await revokeApiKey(id);
        setState((prev) =>
          prev.kind === 'ready'
            ? { kind: 'ready', keys: prev.keys.map((k) => (k.id === id ? key : k)) }
            : prev,
        );
      } catch (err) {
        setActionError(toFriendlyError(err));
        // The key may have been revoked/removed by someone else already —
        // resync the list rather than leaving a stale row on screen.
        await reload();
      } finally {
        setPendingId(null);
        setConfirmingId(null);
      }
    },
    [reload],
  );

  return (
    <>
      <section className={`${card} mb-6`}>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('create.heading')}
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('create.fields.label')}
            </span>
            <input
              className={inputCls}
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('create.fields.rateLimit')}
            </span>
            <input
              className={inputCls}
              type="number"
              min={MIN_RATE_LIMIT}
              max={MAX_RATE_LIMIT}
              placeholder={String(DEFAULT_RATE_LIMIT_HINT)}
              value={rateLimitInput}
              onChange={(e) => setRateLimitInput(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={grantChatWrite}
              onChange={(e) => setGrantChatWrite(e.target.checked)}
            />
            <span className="type-mono-data text-[13px] text-[color:var(--fg)]">
              {CHAT_WRITE_SCOPE}
            </span>
          </label>
          <Button variant="primary" onClick={() => void onCreate()} disabled={!canSubmit} busy={creating} busyLabel={t('create.creating')}>
            {t('create.submit')}
          </Button>
        </div>
        {rateLimitInvalid && (
          <p className="mt-2 text-[13px] text-[color:var(--danger)]">
            {t('create.rateLimitInvalid', { min: MIN_RATE_LIMIT, max: MAX_RATE_LIMIT })}
          </p>
        )}
        {!grantChatWrite && (
          <p className="mt-2 text-[13px] text-[color:var(--danger)]">{t('create.scopesRequired')}</p>
        )}
        {createError && <p className="mt-2 text-[13px] text-[color:var(--danger)]">{createError}</p>}
      </section>

      {revealed && (
        <section
          className="mb-6 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)]/5 p-4"
          role="alert"
        >
          <p className="mb-1 text-[13px] font-semibold text-[color:var(--fg-strong)]">
            {t('reveal.heading')}
          </p>
          <p className="mb-3 text-[13px] text-[color:var(--fg-muted)]">{t('reveal.warning')}</p>
          <code className="type-mono-data block break-all rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] p-3 text-[13px] text-[color:var(--fg-strong)]">
            {revealed.token}
          </code>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => void onCopyToken()}>
              {copyState === 'copied' ? t('reveal.copied') : t('reveal.copy')}
            </Button>
            <Button variant="ghost" onClick={onDismissRevealed}>
              {t('reveal.dismiss')}
            </Button>
            {copyState === 'failed' && (
              <span className="text-[12px] text-[color:var(--danger)]">{t('reveal.copyFailed')}</span>
            )}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('list.heading')}
        </h2>

        {state.kind === 'loading' ? (
          <p className="text-sm opacity-70">{t('list.loading')}</p>
        ) : state.kind === 'error' ? (
          <p className="text-sm text-[color:var(--danger)]">{state.message}</p>
        ) : state.keys.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('list.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.keys.map((key) => {
              const isActive = key.revokedAt === undefined;
              const isPending = pendingId === key.id;
              const isConfirming = confirmingId === key.id;
              return (
                <li key={key.id} className={card}>
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
                          {key.label || t('list.unlabeled')}
                        </span>
                        <KeyStatusBadge revokedAt={key.revokedAt} />
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {key.scopes.map((scope) => (
                          <span key={scope} className={chipCls}>
                            {scope}
                          </span>
                        ))}
                      </div>
                      <span className="text-[12px] text-[color:var(--fg-muted)]">
                        {t('list.rateLimitValue', { value: key.rateLimitPerMinute })}
                        {' · '}
                        {t('list.createdAt', { date: new Date(key.createdAt).toLocaleString() })}
                      </span>
                    </div>
                    {isActive && !isConfirming && (
                      <Button variant="danger" size="sm" onClick={() => setConfirmingId(key.id)}>
                        {t('list.revoke')}
                      </Button>
                    )}
                  </div>

                  {isActive && isConfirming && (
                    <div className="mt-3 border-t border-[color:var(--border)] pt-3">
                      <p className="mb-2 text-[13px] text-[color:var(--fg)]">
                        {t('list.confirmRevoke.message')}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void onConfirmRevoke(key.id)}
                          busy={isPending}
                          busyLabel={t('list.revoking')}
                        >
                          {t('list.confirmRevoke.confirm')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmingId(null)}
                          disabled={isPending}
                        >
                          {t('list.confirmRevoke.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {actionError && <p className="mt-4 text-sm text-[color:var(--danger)]">{actionError}</p>}
      </section>
    </>
  );
}
