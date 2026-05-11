'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

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
      setPatchMessage('Gespeichert.');
    } catch (err) {
      if (err instanceof ApiError && err.body.includes('self_lockout')) {
        setPatchError(
          'Du kannst dich nicht selbst deaktivieren. Anderer Admin muss diese Aktion durchführen.',
        );
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
      setResetError('Passwort muss mindestens 8 Zeichen lang sein.');
      return;
    }
    setResetting(true);
    try {
      await resetAdminUserPassword(id, newPassword);
      setResetMessage('Passwort wurde zurückgesetzt.');
      setNewPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.body.includes('not_local')) {
        setResetError(
          'Passwort-Reset funktioniert nur für lokale Konten. Föderierte Identitäten werden vom IdP verwaltet.',
        );
      } else {
        setResetError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (
      !window.confirm(
        'Diesen Nutzer wirklich löschen? Die Aktion ist nicht umkehrbar.',
      )
    ) {
      return;
    }
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAdminUser(id);
      router.replace('/admin/users');
    } catch (err) {
      if (err instanceof ApiError && err.body.includes('self_lockout')) {
        setDeleteError('Du kannst dich nicht selbst löschen.');
      } else {
        setDeleteError(err instanceof Error ? err.message : String(err));
      }
      setDeleting(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <main className="mx-auto max-w-[720px] px-6 py-12">
        <p className="text-sm opacity-70">Lädt …</p>
      </main>
    );
  }
  if (state.kind === 'error') {
    return (
      <main className="mx-auto max-w-[720px] px-6 py-12">
        <p className="text-sm text-red-500">
          Fehler beim Laden: {state.message}
        </p>
        <Link
          href="/admin/users"
          className="mt-4 inline-block text-sm text-[color:var(--accent)] hover:underline"
        >
          ← zur Übersicht
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
        ← zur Übersicht
      </Link>

      <header className="mb-8 mt-3">
        <h1 className="font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {state.user.email}
        </h1>
        <p className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          Provider: {state.user.provider} · ID: {state.user.id}
        </p>
      </header>

      <section className="mb-8 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-[color:var(--fg-strong)]">
          Profil
        </h2>
        <form onSubmit={handlePatch} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Anzeigename</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Status</span>
            <select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value === 'disabled' ? 'disabled' : 'active')
              }
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            >
              <option value="active">aktiv</option>
              <option value="disabled">deaktiviert</option>
            </select>
          </label>
          {patchMessage && (
            <p className="text-sm text-emerald-500">{patchMessage}</p>
          )}
          {patchError && <p className="text-sm text-red-500">{patchError}</p>}
          <button
            type="submit"
            disabled={savingPatch}
            className="self-start rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
          >
            {savingPatch ? 'Speichere …' : 'Speichern'}
          </button>
        </form>
      </section>

      {isLocal && (
        <section className="mb-8 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
          <h2 className="mb-3 text-[15px] font-semibold text-[color:var(--fg-strong)]">
            Passwort zurücksetzen
          </h2>
          <p className="mb-3 text-sm text-[color:var(--fg-muted)]">
            Setzt das Passwort sofort. Der Nutzer wird nicht benachrichtigt —
            teile das neue Passwort über einen sicheren Kanal mit.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="font-medium">Neues Passwort (mind. 8)</span>
              <input
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleResetPassword()}
              disabled={resetting}
              className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--card)] disabled:opacity-50"
            >
              {resetting ? 'Setze …' : 'Zurücksetzen'}
            </button>
          </div>
          {resetMessage && (
            <p className="mt-3 text-sm text-emerald-500">{resetMessage}</p>
          )}
          {resetError && (
            <p className="mt-3 text-sm text-red-500">{resetError}</p>
          )}
        </section>
      )}

      <section className="rounded-[14px] border border-red-500/30 bg-red-500/5 p-5">
        <h2 className="mb-2 text-[15px] font-semibold text-red-500">
          Gefahrenzone
        </h2>
        <p className="mb-3 text-sm text-[color:var(--fg-muted)]">
          Löschen entfernt den Nutzer permanent. Audit-Log behält den Eintrag.
        </p>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={deleting}
          className="rounded-md border border-red-500/40 px-4 py-2 text-sm font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
        >
          {deleting ? 'Lösche …' : 'Nutzer löschen'}
        </button>
        {deleteError && (
          <p className="mt-3 text-sm text-red-500">{deleteError}</p>
        )}
      </section>
    </main>
  );
}
