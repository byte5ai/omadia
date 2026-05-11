'use client';

/**
 * Theme D — post-install credential editor.
 *
 * Renders one input per declared SetupField. On mount, fetches the list
 * of secret-key NAMES already in the vault (no values) so we can mark
 * existing keys with a "stored" placeholder. Operator types a new value
 * to upsert it; explicit "Löschen" button next to a stored key removes
 * it. Save flushes the diff via PATCH /admin/runtime/installed/:id/secrets.
 *
 * Why a client component (and not the Setup-Wizard form): the Wizard is
 * specifically the install-time gate. This editor exists for the
 * post-install case Marcel raised — secrets that the provider only
 * returns AFTER the first authenticated call (refresh-tokens, webhook
 * secrets after registration, etc.). Same vault, different UX moment.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Trash2 } from 'lucide-react';

import {
  ApiError,
  listInstalledSecretKeys,
  patchInstalledSecrets,
} from '../../_lib/api';
import type { PluginSetupField } from '../../_lib/storeTypes';

interface CredentialsEditorProps {
  pluginId: string;
  /**
   * The setup_fields from the plugin's manifest. We render an input for
   * every entry; non-secret types render too because the same vault is
   * the canonical store for `string` / `url` / `oauth` / `enum` /
   * `boolean` / `integer` per the SetupField spec — operators may need
   * to rotate any of them. (`boolean` and `integer` get coerced to
   * string before patch since the vault stores strings.)
   */
  setupFields: ReadonlyArray<PluginSetupField>;
}

interface FieldState {
  draft: string;
  /** True when the operator typed something (vs leaving the prefill alone). */
  dirty: boolean;
  /** True when the operator clicked the trashcan but hasn't saved yet. */
  pendingDelete: boolean;
}

export function CredentialsEditor({
  pluginId,
  setupFields,
}: CredentialsEditorProps): React.ReactElement {
  const [storedKeys, setStoredKeys] = useState<Set<string> | null>(null);
  // Actual stored values for non-secret fields. Secrets stay server-side
  // and are absent here even when stored. Used to (a) display the
  // current selection in dropdowns and (b) prefill text inputs so the
  // operator can see what's stored before deciding to overwrite.
  const [storedValues, setStoredValues] = useState<Record<string, string>>(
    {},
  );
  const [fieldStates, setFieldStates] = useState<Record<string, FieldState>>(
    () =>
      Object.fromEntries(
        setupFields.map((f) => [
          f.key,
          { draft: '', dirty: false, pendingDelete: false },
        ]),
      ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refreshKeys = useCallback(async () => {
    try {
      const { keys, config_keys, config_values } =
        await listInstalledSecretKeys(pluginId);
      // Setup values are split between two stores at install time:
      // secret/oauth → vault (`keys`, names only), everything else →
      // registry config (`config_keys` + `config_values`). The editor
      // unions both sets to mark fields as "stored", and uses
      // `config_values` to surface non-secret values inline.
      setStoredKeys(new Set([...keys, ...config_keys]));
      setStoredValues(config_values ?? {});
    } catch (err) {
      // 503 = vault not wired (dev env); 404 = uninstalled. Both leave
      // the editor visible but empty — better than crashing the page.
      if (err instanceof ApiError && (err.status === 503 || err.status === 404)) {
        setStoredKeys(new Set());
        setStoredValues({});
        return;
      }
      setError(humanizeError(err));
      setStoredKeys(new Set());
      setStoredValues({});
    }
  }, [pluginId]);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  const dirtyCount = Object.values(fieldStates).filter(
    (s) => (s.dirty && s.draft.length > 0) || s.pendingDelete,
  ).length;

  const onSave = useCallback(async () => {
    if (saving || dirtyCount === 0) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const set: Record<string, string> = {};
      const del: string[] = [];
      for (const f of setupFields) {
        const s = fieldStates[f.key];
        if (!s) continue;
        if (s.pendingDelete) {
          del.push(f.key);
        } else if (s.dirty && s.draft.length > 0) {
          set[f.key] = s.draft;
        }
      }
      const patch: { set?: Record<string, string>; delete?: string[] } = {};
      if (Object.keys(set).length > 0) patch.set = set;
      if (del.length > 0) patch.delete = del;
      const { keys, config_keys, config_values } = await patchInstalledSecrets(
        pluginId,
        patch,
      );
      setStoredKeys(new Set([...keys, ...config_keys]));
      setStoredValues(config_values ?? {});
      setFieldStates((prev) =>
        Object.fromEntries(
          setupFields.map((f) => {
            const s = prev[f.key];
            return [
              f.key,
              {
                draft: '',
                dirty: false,
                pendingDelete: false,
                ...(s ? {} : {}),
              },
            ];
          }),
        ),
      );
      setSavedAt(Date.now());
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyCount, setupFields, fieldStates, pluginId]);

  if (setupFields.length === 0) {
    return (
      <p className="text-sm italic text-[color:var(--faint-ink)]">
        Dieses Plugin deklariert keine Setup-Felder.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
        Secrets (Passwörter, OAuth-Tokens) werden verschlüsselt im Vault
        gespeichert und nur als „gespeichert&ldquo; angezeigt — niemals der
        eigentliche Wert. Nicht-sensitive Setup-Werte (Enum, URL, Flags) zeigen
        die aktuelle Auswahl. Tippe oder wähle einen neuen Wert um zu
        überschreiben, oder klicke auf <Trash2 className="inline size-3 align-text-bottom" aria-hidden /> um eine Credential zu löschen.
      </div>

      <ul className="divide-y divide-[color:var(--rule)] border-y border-[color:var(--rule)]">
        {setupFields.map((field) => {
          const state =
            fieldStates[field.key] ??
            ({ draft: '', dirty: false, pendingDelete: false } as FieldState);
          const isStored = storedKeys?.has(field.key) ?? false;
          const isSecret = field.type === 'secret' || field.type === 'oauth';
          const enumOptions =
            field.type === 'enum' && field.enum && field.enum.length > 0
              ? field.enum
              : null;
          // For non-secret fields the actual stored value comes back in
          // `config_values`. We use it as the displayed default so the
          // operator sees what's currently active without exposing
          // anything that wasn't already in `installed.config`. Secrets
          // never get a value here — server elides them.
          const storedValue = isSecret ? undefined : storedValues[field.key];
          return (
            <li
              key={field.key}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <KeyRound className="size-3.5 shrink-0 text-[color:var(--muted-ink)]" aria-hidden />
                  <span className="font-mono-num text-[12px] text-[color:var(--ink)]">
                    {field.key}
                  </span>
                  <span className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
                    {field.type}
                  </span>
                </div>
                {field.label ? (
                  <div className="mt-0.5 text-[11px] text-[color:var(--muted-ink)]">
                    {field.label}
                  </div>
                ) : null}
                {field.help ? (
                  <div className="mt-1 text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
                    {field.help}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-1 items-center gap-2">
                {enumOptions ? (
                  (() => {
                    // The dropdown shows either the operator's pending
                    // draft, or — when nothing has been touched — the
                    // value already stored on the server. The empty
                    // option only renders when neither is present.
                    const selectValue = state.dirty
                      ? state.draft
                      : (storedValue ?? '');
                    const placeholder = state.pendingDelete
                      ? 'wird beim Speichern gelöscht'
                      : isStored
                        ? 'gespeichert · auswählen zum Überschreiben'
                        : field.default
                          ? `nicht gesetzt · Default: ${field.default}`
                          : 'nicht gesetzt';
                    return (
                      <select
                        value={selectValue}
                        disabled={state.pendingDelete || saving}
                        onChange={(e) =>
                          setFieldStates((prev) => ({
                            ...prev,
                            [field.key]: {
                              draft: e.target.value,
                              dirty: true,
                              pendingDelete: false,
                            },
                          }))
                        }
                        className="min-w-0 flex-1 rounded-md border border-[color:var(--rule)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[12px] text-[color:var(--ink)] focus:border-[color:var(--accent)] focus:outline-none disabled:opacity-50"
                      >
                        <option value="">{placeholder}</option>
                        {enumOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    );
                  })()
                ) : (
                  (() => {
                    // For non-secret text inputs we surface the stored
                    // value verbatim until the operator types. Secrets
                    // remain blank+masked — the server never returned a
                    // value, so there's nothing to show.
                    const inputValue = state.dirty
                      ? state.draft
                      : (storedValue ?? '');
                    const placeholder = state.pendingDelete
                      ? 'wird beim Speichern gelöscht'
                      : isStored
                        ? isSecret
                          ? 'gespeichert · neu eintippen zum Überschreiben'
                          : 'leeren zum Löschen, neu eintippen zum Überschreiben'
                        : 'noch nicht gesetzt';
                    return (
                      <input
                        type={isSecret ? 'password' : 'text'}
                        value={inputValue}
                        disabled={state.pendingDelete || saving}
                        onChange={(e) =>
                          setFieldStates((prev) => ({
                            ...prev,
                            [field.key]: {
                              draft: e.target.value,
                              dirty: true,
                              pendingDelete: false,
                            },
                          }))
                        }
                        placeholder={placeholder}
                        className="min-w-0 flex-1 rounded-md border border-[color:var(--rule)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[12px] text-[color:var(--ink)] placeholder:text-[color:var(--faint-ink)] focus:border-[color:var(--accent)] focus:outline-none disabled:opacity-50"
                      />
                    );
                  })()
                )}
                {isStored ? (
                  <button
                    type="button"
                    onClick={() =>
                      setFieldStates((prev) => ({
                        ...prev,
                        [field.key]: {
                          draft: '',
                          dirty: false,
                          pendingDelete: !state.pendingDelete,
                        },
                      }))
                    }
                    disabled={saving}
                    title={
                      state.pendingDelete
                        ? 'Löschung abbrechen'
                        : 'Credential beim nächsten Speichern löschen'
                    }
                    className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
                      state.pendingDelete
                        ? 'border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 text-[color:var(--danger)]'
                        : 'border-[color:var(--rule)] text-[color:var(--muted-ink)] hover:border-[color:var(--danger)]/40 hover:text-[color:var(--danger)]'
                    }`}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving || dirtyCount === 0}
          className="inline-flex items-center gap-2 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="size-3.5" aria-hidden />
          )}
          Speichern{dirtyCount > 0 ? ` (${String(dirtyCount)})` : ''}
        </button>
        {savedAt !== null ? (
          <span className="text-[11px] text-[color:var(--muted-ink)]">
            ✓ Gespeichert
          </span>
        ) : null}
        {error ? (
          <span className="text-[11px] text-[color:var(--danger)]">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function humanizeError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { code?: string; message?: string };
      if (body.code && body.message) return `${body.code}: ${body.message}`;
      if (body.message) return body.message;
    } catch {
      // fall through
    }
    return `HTTP ${String(err.status)}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
