'use client';

import { useEffect, useState } from 'react';

import {
  ApiError,
  StoredRegistry,
  addRegistry,
  deleteRegistry,
  listRegistries,
  updateRegistry,
} from '../../_lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; registries: StoredRegistry[] }
  | { kind: 'error'; message: string };

/**
 * Admin UI for the plugin registries Core pulls from (the "store sources").
 *
 * Backend: /api/v1/admin/registries (CRUD). The bearer token is write-only —
 * the listing only flags `has_token`. Changes apply without a restart (the
 * live RegistryClient is reloaded server-side after each mutation). A fresh
 * install is seeded with the public default `hub.omadia.ai`.
 */
export default function AdminRegistriesPage(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);

  // add-form
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [adding, setAdding] = useState(false);

  // per-row pending + edit state
  const [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editToken, setEditToken] = useState('');

  async function reload(): Promise<void> {
    try {
      const res = await listRegistries();
      setState({ kind: 'ready', registries: res.registries });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, []);

  async function onAdd(): Promise<void> {
    setActionError(null);
    setAdding(true);
    try {
      await addRegistry({
        name: name.trim(),
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setName('');
      setUrl('');
      setToken('');
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setAdding(false);
    }
  }

  function startEdit(r: StoredRegistry): void {
    setActionError(null);
    setEditing(r.name);
    setEditUrl(r.url);
    setEditToken('');
  }

  async function onSaveEdit(r: StoredRegistry): Promise<void> {
    setActionError(null);
    setPending(r.name);
    try {
      const patch: { url?: string; token?: string | null } = {};
      if (editUrl.trim() && editUrl.trim() !== r.url) patch.url = editUrl.trim();
      if (editToken.trim()) patch.token = editToken.trim();
      if (Object.keys(patch).length > 0) await updateRegistry(r.name, patch);
      setEditing(null);
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setPending(null);
    }
  }

  async function onClearToken(r: StoredRegistry): Promise<void> {
    setActionError(null);
    setPending(r.name);
    try {
      await updateRegistry(r.name, { token: null });
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setPending(null);
    }
  }

  async function onDelete(r: StoredRegistry): Promise<void> {
    if (!confirm(`Registry „${r.name}" wirklich entfernen?`)) return;
    setActionError(null);
    setPending(r.name);
    try {
      await deleteRegistry(r.name);
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err));
    } finally {
      setPending(null);
    }
  }

  const canAdd = name.trim().length > 0 && url.trim().length > 0 && !adding;

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Plugin-Registries
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          Quellen, aus denen Plugins in den Store gezogen werden. Neue Instanzen
          starten mit{' '}
          <code className="rounded bg-[color:var(--card)] px-1 py-0.5 text-[12px]">
            hub.omadia.ai
          </code>
          . Der Token wird verschlüsselt gespeichert und nie wieder angezeigt —
          nur, ob einer hinterlegt ist. Änderungen wirken ohne Neustart.
        </p>
      </header>

      {/* Add form */}
      <section className="mb-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-[color:var(--fg-strong)]">
          Registry hinzufügen
        </h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr_1.5fr_auto] sm:items-end">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="omadia-public"
              className={inputCls}
            />
          </Field>
          <Field label="URL">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hub.omadia.ai"
              className={inputCls}
            />
          </Field>
          <Field label="Token (optional)">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="nur für private Registries"
              type="password"
              className={inputCls}
            />
          </Field>
          <button
            type="button"
            onClick={() => void onAdd()}
            disabled={!canAdd}
            className="rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-[color:var(--text-inverse)] disabled:opacity-50"
          >
            {adding ? '…' : 'Hinzufügen'}
          </button>
        </div>
      </section>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">Lädt …</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">Fehler beim Laden: {state.message}</p>
      ) : state.registries.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">
          Keine Registries konfiguriert.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.registries.map((r) => (
            <li
              key={r.name}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
                      {r.name}
                    </span>
                    <TokenBadge hasToken={r.has_token} />
                  </div>
                  <code className="text-[13px] text-[color:var(--fg-muted)]">
                    {r.url}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      editing === r.name ? setEditing(null) : startEdit(r)
                    }
                    disabled={pending === r.name}
                    className="rounded-md border border-[color:var(--border)] px-3 py-2 text-sm font-medium text-[color:var(--fg-strong)] hover:bg-[color:var(--card)] disabled:opacity-50"
                  >
                    {editing === r.name ? 'Abbrechen' : 'Bearbeiten'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(r)}
                    disabled={pending === r.name}
                    className="rounded-md border border-[color:var(--border)] px-3 py-2 text-sm font-medium text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10 disabled:opacity-50"
                  >
                    {pending === r.name ? '…' : 'Entfernen'}
                  </button>
                </div>
              </div>

              {editing === r.name && (
                <div className="mt-4 grid gap-3 border-t border-[color:var(--border)] pt-4 sm:grid-cols-[2fr_1.5fr_auto] sm:items-end">
                  <Field label="URL">
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Token ersetzen">
                    <input
                      value={editToken}
                      onChange={(e) => setEditToken(e.target.value)}
                      placeholder={r.has_token ? '•••••• (unverändert)' : 'keiner'}
                      type="password"
                      className={inputCls}
                    />
                  </Field>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void onSaveEdit(r)}
                      disabled={pending === r.name}
                      className="rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-[color:var(--text-inverse)] disabled:opacity-50"
                    >
                      Speichern
                    </button>
                    {r.has_token && (
                      <button
                        type="button"
                        onClick={() => void onClearToken(r)}
                        disabled={pending === r.name}
                        className="rounded-md border border-[color:var(--border)] px-3 py-2 text-sm font-medium text-[color:var(--fg-muted)] hover:bg-[color:var(--card)] disabled:opacity-50"
                      >
                        Token entfernen
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {actionError && <p className="mt-4 text-sm text-[color:var(--danger)]">{actionError}</p>}
    </main>
  );
}

const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function TokenBadge({ hasToken }: { hasToken: boolean }): React.ReactElement {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
        hasToken
          ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
          : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
      ].join(' ')}
    >
      {hasToken ? 'Token gesetzt' : 'öffentlich'}
    </span>
  );
}

function toFriendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body.includes('registry_config.duplicate')) {
      return 'Eine Registry mit diesem Namen existiert bereits.';
    }
    if (err.body.includes('invalid_url')) {
      return 'Die URL ist ungültig (http(s) erforderlich).';
    }
    if (err.body.includes('invalid_name')) {
      return 'Der Name darf nur Buchstaben, Zahlen, . _ - enthalten.';
    }
    if (err.body.includes('not_found')) {
      return 'Registry nicht gefunden — Liste neu geladen.';
    }
    if (err.body.includes('missing_fields')) {
      return 'Name und URL sind erforderlich.';
    }
    return `Fehler ${err.status}.`;
  }
  return err instanceof Error ? err.message : String(err);
}
