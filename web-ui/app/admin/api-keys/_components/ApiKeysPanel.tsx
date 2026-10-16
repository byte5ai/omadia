'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  deleteApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyPublicView,
  type CreateApiKeyResult,
} from '@/app/_lib/api';

import { CreateKeyForm } from './CreateKeyForm';
import { KeyRow } from './KeyRow';
import { errorInlineCls, errorTextCls, keyStatusOf, toFriendlyError } from './shared';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; keys: ApiKeyPublicView[] }
  | { kind: 'error'; message: string };

/** Immutable add/remove for the per-key `pendingIds` set — every row's
 *  in-flight state is tracked by its own key id rather than a single shared
 *  value, so two rows can be mid-action at once without one clobbering the
 *  other's state (codex review finding). */
function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) return set;
  return new Set(set).add(id);
}
function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function ApiKeysPanel(): React.ReactElement {
  const t = useTranslations('adminApiKeys');

  const [state, setState] = useState<State>({ kind: 'loading' });
  // Guards against out-of-order responses: only the most recently ISSUED
  // reload's result is ever applied to `state`. Without this, a slow initial
  // mount fetch that resolves AFTER a post-create reload (which already
  // reflects the new key) could stomp the newer state with stale data.
  const reloadSeqRef = useRef(0);
  // Snapshot of "now" for expiry status, refreshed with every reload so a
  // render never flips a key's status on its own mid-interaction.
  const [now, setNow] = useState(() => Date.now());

  // Reveal-once token, set only by a successful create. Cleared by an
  // explicit dismiss — never auto-hidden, never re-derived from a fetch (the
  // list endpoint never returns a token field, so there is nothing to leak
  // even if this state were repopulated from a reload). Creation is BLOCKED
  // while a reveal is on screen — otherwise a second create would silently
  // overwrite the first key's only-ever-shown token before the operator had
  // a chance to copy it.
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  // #1328 — revoked/expired keys stay deletable but are hidden by default so
  // the list doesn't only ever grow.
  const [showInactive, setShowInactive] = useState(false);
  // Keys revoked on this page stay visible (as Revoked) until the next visit,
  // so a revoke never looks like the row just vanished.
  const [revokedHere, setRevokedHere] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++reloadSeqRef.current;
    try {
      const res = await listApiKeys();
      if (seq !== reloadSeqRef.current) return; // superseded by a newer reload
      setNow(Date.now());
      setState({ kind: 'ready', keys: res.keys });
    } catch (err) {
      if (seq !== reloadSeqRef.current) return;
      setState({ kind: 'error', message: toFriendlyError(err, t) });
    }
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const onCreated = useCallback(
    async (created: CreateApiKeyResult): Promise<void> => {
      setCopyState('idle');
      setRevealed({ id: created.key.id, token: created.token });
      await reload();
    },
    [reload],
  );

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

  /** Runs one row action; on failure shows the error and resyncs the list
   *  (the key may have been changed or removed by someone else already). */
  const runRowAction = useCallback(
    async (id: string, action: () => Promise<void>): Promise<void> => {
      setActionError(null);
      setPendingIds((prev) => withId(prev, id));
      try {
        await action();
      } catch (err) {
        setActionError(toFriendlyError(err, t));
        await reload();
      } finally {
        setPendingIds((prev) => withoutId(prev, id));
      }
    },
    [reload, t],
  );

  const onRevoke = useCallback(
    (id: string) =>
      runRowAction(id, async () => {
        const { key } = await revokeApiKey(id);
        setRevokedHere((prev) => withId(prev, id));
        setState((prev) =>
          prev.kind === 'ready'
            ? { kind: 'ready', keys: prev.keys.map((k) => (k.id === id ? { ...k, ...key } : k)) }
            : prev,
        );
      }),
    [runRowAction],
  );

  const onDelete = useCallback(
    (id: string) =>
      runRowAction(id, async () => {
        await deleteApiKey(id);
        setState((prev) =>
          prev.kind === 'ready' ? { kind: 'ready', keys: prev.keys.filter((k) => k.id !== id) } : prev,
        );
      }),
    [runRowAction],
  );

  const inactiveCount =
    state.kind === 'ready' ? state.keys.filter((k) => keyStatusOf(k, now) !== 'active').length : 0;
  const visibleKeys =
    state.kind === 'ready'
      ? state.keys.filter(
          (k) => showInactive || revokedHere.has(k.id) || keyStatusOf(k, now) === 'active',
        )
      : [];

  return (
    <>
      {/* #1324 — the one-time token sits ABOVE the create form: it is the
          one thing the operator must act on, and the locked form's hint
          ("dismiss the token above") points here. */}
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
              <span className={errorInlineCls}>{t('reveal.copyFailed')}</span>
            )}
          </div>
        </section>
      )}

      <CreateKeyForm locked={!!revealed} onCreated={onCreated} />

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('list.heading')}
          </h2>
          {(inactiveCount > 0 || showInactive) && (
            <Button variant="ghost" size="sm" onClick={() => setShowInactive((v) => !v)}>
              {showInactive ? t('list.hideInactive') : t('list.showInactive', { count: inactiveCount })}
            </Button>
          )}
        </div>

        {state.kind === 'loading' ? (
          <p className="text-sm opacity-70">{t('list.loading')}</p>
        ) : state.kind === 'error' ? (
          <p className={errorTextCls}>{state.message}</p>
        ) : state.keys.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('list.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visibleKeys.map((key) => (
              <KeyRow
                key={key.id}
                apiKey={key}
                now={now}
                pending={pendingIds.has(key.id)}
                onRevoke={onRevoke}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}

        {actionError && <p className={`mt-4 ${errorTextCls}`}>{actionError}</p>}
      </section>
    </>
  );
}
