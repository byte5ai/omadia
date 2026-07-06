'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  AdminUser,
  ApiError,
  deleteAdminUser,
  getAdminUser,
  resetAdminUserPassword,
  updateAdminUser,
} from '../../../_lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; user: AdminUser }
  | { kind: 'error'; message: string };

export default function AdminUserEditPage(): React.ReactElement {
  const t = useTranslations('adminUsers');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? '';

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [savingPatch, setSavingPatch] = useState(false);
  const [patchMessage, setPatchMessage] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function load(): Promise<void> {
    if (!id) return;
    try {
      const res = await getAdminUser(id);
      setState({ kind: 'ready', user: res.user });
      setDisplayName(res.user.display_name);
      setStatus(res.user.status);
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    // Fetch-on-mount: load() touches state only after the awaited network
    // round-trip — no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handlePatch(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setPatchError(null);
    setPatchMessage(null);
    setSavingPatch(true);
    try {
      const res = await updateAdminUser(id, {
        display_name: displayName,
        status,
      });
      setState({ kind: 'ready', user: res.user });
      setPatchMessage(t('edit.saved'));
    } catch (err) {
      if (err instanceof ApiError && err.body.includes('self_lockout')) {
        setPatchError(t('errors.selfDisable'));
      } else {
        setPatchError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSavingPatch(false);
    }
  }

  async function handleResetPassword(): Promise<void> {
    setResetError(null);
    setResetMessage(null);
    if (newPassword.length < 8) {
      setResetError(t('errors.passwordMinLength'));
      return;
    }
    setResetting(true);
    try {
      await resetAdminUserPassword(id, newPassword);
      setResetMessage(t('edit.resetSuccess'));
      setNewPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.body.includes('not_local')) {
        setResetError(t('errors.notLocal'));
      } else {
        setResetError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!window.confirm(t('edit.confirmDelete'))) {
      return;
    }
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAdminUser(id);
      router.replace('/admin/users');
    } catch (err) {
      if (err instanceof ApiError && err.body.includes('self_lockout')) {
        setDeleteError(t('errors.selfDelete'));
      } else {
        setDeleteError(err instanceof Error ? err.message : String(err));
      }
      setDeleting(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <main className="mx-auto max-w-[720px] px-6 py-12">
        <p className="text-sm opacity-70">{t('loading')}</p>
      </main>
    );
  }
  if (state.kind === 'error') {
    return (
      <main className="mx-auto max-w-[720px] px-6 py-12">
        <p className="text-sm text-[color:var(--danger)]">
          {t('loadError', { message: state.message })}
        </p>
        <Link
          href="/admin/users"
          className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
        >
          ← {t('edit.backToList')}
        </Link>
      </main>
    );
  }

  const isLocal = state.user.provider === 'local';

  return (
    <main className="mx-auto max-w-[720px] px-6 py-12 lg:py-16">
      <Link
        href="/admin/users"
        className="text-sm text-[color:var(--accent)] hover:underline"
      >
        ← {t('edit.backToList')}
      </Link>

      <header className="mb-8 mt-3">
        <h1 className="font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {state.user.email}
        </h1>
        <p className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('edit.providerAndId', { provider: state.user.provider, id: state.user.id })}
        </p>
      </header>

      <section className="mb-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[15px] font-semibold text-[color:var(--fg-strong)]">
          {t('edit.profileHeading')}
        </h2>
        <form onSubmit={handlePatch} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('edit.displayName')}</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('edit.status')}</span>
            <select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value === 'disabled' ? 'disabled' : 'active')
              }
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            >
              <option value="active">{t('edit.statusActive')}</option>
              <option value="disabled">{t('edit.statusDisabled')}</option>
            </select>
          </label>
          {patchMessage && (
            <p className="text-sm text-[color:var(--success)]">{patchMessage}</p>
          )}
          {patchError && <p className="text-sm text-[color:var(--danger)]">{patchError}</p>}
          <Button
            type="submit"
            variant="primary"
            disabled={savingPatch}
            className="self-start"
          >
            {savingPatch ? t('edit.saving') : t('edit.save')}
          </Button>
        </form>
      </section>

      {isLocal && (
        <section className="mb-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
          <h2 className="mb-3 text-[15px] font-semibold text-[color:var(--fg-strong)]">
            {t('edit.resetHeading')}
          </h2>
          <p className="mb-3 text-sm text-[color:var(--fg-muted)]">
            {t('edit.resetHelp')}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="font-medium">{t('edit.newPassword')}</span>
              <input
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
              />
            </label>
            <Button
              variant="secondary"
              onClick={() => void handleResetPassword()}
              disabled={resetting}
            >
              {resetting ? t('edit.resetting') : t('edit.reset')}
            </Button>
          </div>
          {resetMessage && (
            <p className="mt-3 text-sm text-[color:var(--success)]">{resetMessage}</p>
          )}
          {resetError && (
            <p className="mt-3 text-sm text-[color:var(--danger)]">{resetError}</p>
          )}
        </section>
      )}

      <section className="rounded-lg border border-[color:var(--danger-edge)]/30 bg-[color:var(--danger)]/5 p-4">
        <h2 className="mb-2 text-[15px] font-semibold text-[color:var(--danger)]">
          {t('edit.dangerHeading')}
        </h2>
        <p className="mb-3 text-sm text-[color:var(--fg-muted)]">
          {t('edit.dangerHelp')}
        </p>
        <Button
          variant="danger"
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? t('edit.deleting') : t('edit.delete')}
        </Button>
        {deleteError && (
          <p className="mt-3 text-sm text-[color:var(--danger)]">{deleteError}</p>
        )}
      </section>
    </main>
  );
}
