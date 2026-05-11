'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  AdminUser,
  ApiError,
  createAdminUser,
  listAdminUsers,
} from '../../_lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; users: AdminUser[] }
  | { kind: 'error'; message: string };

export default function AdminUsersPage(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const res = await listAdminUsers();
      setState({ kind: 'ready', users: res.users });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleCreate(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setCreateError(null);
    if (newPassword.length < 8) {
      setCreateError('Passwort muss mindestens 8 Zeichen lang sein.');
      return;
    }
    setSubmitting(true);
    try {
      await createAdminUser({
        email: newEmail.trim(),
        password: newPassword,
        ...(newDisplay.trim().length > 0
          ? { display_name: newDisplay.trim() }
          : {}),
      });
      setNewEmail('');
      setNewPassword('');
      setNewDisplay('');
      setShowCreate(false);
      await reload();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.body.includes('email_in_use')) {
          setCreateError(
            'Diese Email ist bereits als lokaler Nutzer registriert.',
          );
        } else if (err.body.includes('password_too_short')) {
          setCreateError('Passwort zu kurz (mind. 8 Zeichen).');
        } else if (err.body.includes('invalid_email')) {
          setCreateError('Ungültige Email-Adresse.');
        } else {
          setCreateError(`Fehler ${err.status}: ${err.message}`);
        }
      } else {
        setCreateError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1080px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
            Benutzer
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
            Lokale Konten und föderierte Identitäten. Nur lokale Nutzer können
            hier neu angelegt werden — föderierte Konten erscheinen, sobald der
            Nutzer sich einmal über den IdP angemeldet hat.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-black"
        >
          {showCreate ? 'Abbrechen' : 'Neuen Nutzer anlegen'}
        </button>
      </header>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-8 grid gap-4 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5 sm:grid-cols-2"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Email</span>
            <input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Anzeigename (optional)</span>
            <input
              type="text"
              value={newDisplay}
              onChange={(e) => setNewDisplay(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="font-medium">Passwort (mind. 8 Zeichen)</span>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          {createError && (
            <p className="text-sm text-red-500 sm:col-span-2">{createError}</p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50 sm:col-span-2"
          >
            {submitting ? 'Lege an …' : 'Anlegen'}
          </button>
        </form>
      )}

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">Lädt …</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-red-500">
          Fehler beim Laden: {state.message}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-[color:var(--border)]">
          <table className="w-full text-left text-sm">
            <thead className="bg-[color:var(--card)]/40 text-[12px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Letzte Anmeldung</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {state.users.map((u) => (
                <tr
                  key={u.id}
                  className="border-t border-[color:var(--border)]/50"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-[color:var(--fg-strong)]">
                      {u.email}
                    </div>
                    {u.display_name && u.display_name !== u.email && (
                      <div className="text-xs text-[color:var(--fg-muted)]">
                        {u.display_name}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--fg-muted)]">
                    {u.provider}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={[
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
                        u.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-500'
                          : 'bg-amber-500/10 text-amber-500',
                      ].join(' ')}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[color:var(--fg-muted)]">
                    {u.last_login_at ? formatDate(u.last_login_at) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="text-sm text-[color:var(--accent)] hover:underline"
                    >
                      Bearbeiten →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}
