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
 * post-install case John raised — secrets that the provider only
 * returns AFTER the first authenticated call (refresh-tokens, webhook
 * secrets after registration, etc.). Same vault, different UX moment.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  Plug,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import {
  ApiError,
  fetchSetupFieldOptions,
  listInstalledSecretKeys,
  patchInstalledConfig,
  patchInstalledSecrets,
  type SetupOption,
} from '../../_lib/api';
import { pickLocalized } from '../../_lib/localized';
import {
  resolveSetupFieldHint,
  violatesSetupPattern,
} from '../../_lib/setupFieldPattern';
import type { PluginSetupField } from '../../_lib/storeTypes';
import { Button } from '@/app/_components/ui/Button';

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
  const t = useTranslations('store.credentials');
  const locale = useLocale();
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
    // Fetch-on-mount: refreshKeys() touches state only after the awaited
    // fetch — no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshKeys();
  }, [refreshKeys]);

  const dirtyCount = Object.values(fieldStates).filter(
    (s) => (s.dirty && s.draft.length > 0) || s.pendingDelete,
  ).length;

  /**
   * OM-17 — keys whose pending draft violates the manifest `pattern`.
   *
   * Only DIRTY drafts are checked: a stored value that predates the pattern
   * (or a non-secret value echoed back from `config_values`) must not
   * retroactively block an unrelated edit. Mirrors the server, which also only
   * validates the values in the incoming patch.
   */
  const invalidKeys = useMemo(() => {
    const out = new Set<string>();
    for (const f of setupFields) {
      if (f.options_provider && f.multi) continue;
      const s = fieldStates[f.key];
      if (!s?.dirty || s.pendingDelete) continue;
      if (violatesSetupPattern(f, s.draft)) out.add(f.key);
    }
    return out;
  }, [setupFields, fieldStates]);

  const onSave = useCallback(async () => {
    // The server rejects these too (that check is the load-bearing one); this
    // just spares the operator a round trip and an all-or-nothing 400.
    if (saving || dirtyCount === 0 || invalidKeys.size > 0) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const set: Record<string, string> = {};
      const del: string[] = [];
      for (const f of setupFields) {
        // Multiselect (options_provider) fields persist themselves through
        // patchInstalledConfig in MultiselectField — never via this scalar
        // secrets patch (which cannot carry arrays).
        if (f.options_provider && f.multi) continue;
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
      setError(humanizeSecretsPatchError(err, setupFields, locale));
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    dirtyCount,
    invalidKeys,
    setupFields,
    fieldStates,
    pluginId,
    locale,
  ]);

  if (setupFields.length === 0) {
    return (
      <p className="text-sm italic text-[color:var(--faint-ink)]">
        {t('noFields')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
        {t.rich('intro', {
          secret: (chunks) => (
            <span className="font-semibold text-[color:var(--accent)]">
              {chunks}
            </span>
          ),
          config: (chunks) => <span className="font-semibold">{chunks}</span>,
          trashIcon: () => (
            <Trash2
              className="inline size-3 align-text-bottom"
              aria-hidden
            />
          ),
        })}
      </div>

      <ul className="divide-y divide-[color:var(--rule)] border-y border-[color:var(--rule)]">
        {setupFields.map((field) => {
          const state =
            fieldStates[field.key] ??
            ({ draft: '', dirty: false, pendingDelete: false } as FieldState);
          const isStored = storedKeys?.has(field.key) ?? false;
          const isSecret = field.type === 'secret' || field.type === 'oauth';
          const isMultiselect = Boolean(field.options_provider && field.multi);
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
          const isInvalid = invalidKeys.has(field.key);
          // OM-17 — the manifest's own explanation of the expected shape. An
          // OAuth field has no typeable value, so no shape to explain.
          const patternHint =
            field.type === 'oauth'
              ? undefined
              : pickLocalized(field.pattern_hint, locale);
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
                  {/* Storage classification — makes the Secret-vs-Config split
                      explicit so plain config fields aren't read as
                      "credentials". Secrets/OAuth land in the encrypted vault;
                      everything else is instance config. */}
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                      isSecret
                        ? 'bg-[color:var(--accent)]/12 text-[color:var(--accent)]'
                        : 'bg-[color:var(--rule)]/50 text-[color:var(--muted-ink)]'
                    }`}
                    title={
                      isSecret
                        ? t('secretBadgeTitle')
                        : t('configBadgeTitle')
                    }
                  >
                    {isSecret ? 'Secret · Vault' : 'Config'}
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
                {/* OM-17 — THE single highest-value line in this file.
                    A customer saw a masked input under an email field and
                    entered their real Google account password; the system said
                    "gespeichert". omadia never asks for an account password —
                    every `secret` field wants a technical key from a provider
                    console. This warning is unconditional and manifest-
                    independent so it protects EVERY plugin, including ones
                    whose manifests we do not control. */}
                {field.type === 'secret' ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium leading-relaxed text-[color:var(--warning)]">
                    <ShieldAlert
                      className="mt-px size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span>{t('noPasswordWarning')}</span>
                  </p>
                ) : null}
                {patternHint ? (
                  <div className="mt-1 text-[11px] leading-relaxed text-[color:var(--muted-ink)]">
                    {patternHint}
                  </div>
                ) : null}
                {/* OM-17 — the manifest declared a format check the server
                    refused, so this field is NOT validated. Say so instead of
                    rendering a field that merely looks checked. */}
                {field.pattern_unavailable ? (
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-[color:var(--warning)]">
                    <ShieldAlert
                      className="mt-px size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span>{t('patternUnavailable')}</span>
                  </p>
                ) : null}
                {isInvalid ? (
                  <p
                    role="alert"
                    className="mt-1 text-[11px] leading-relaxed text-[color:var(--danger)]"
                  >
                    {patternHint ?? t('patternMismatch')}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-1 items-center gap-2">
                {isMultiselect ? (
                  <MultiselectField
                    pluginId={pluginId}
                    fieldKey={field.key}
                    storedValue={storedValues[field.key]}
                  />
                ) : field.type === 'oauth' ? (
                  // Spec 005 — an OAuth field has no typeable value; the kernel
                  // broker holds the tokens. Render a Connect button that
                  // navigates (top-level, so the server can 302 to the IdP) to
                  // `/oauth/start`. "Connected" = the token bundle exists in the
                  // vault under the reserved `oauth.<key>` name.
                  <OAuthConnectField
                    pluginId={pluginId}
                    fieldKey={field.key}
                    connected={storedKeys?.has(`oauth.${field.key}`) ?? false}
                  />
                ) : enumOptions ? (
                  (() => {
                    // The dropdown shows either the operator's pending
                    // draft, or — when nothing has been touched — the
                    // value already stored on the server. The empty
                    // option only renders when neither is present.
                    const selectValue = state.dirty
                      ? state.draft
                      : (storedValue ?? '');
                    const placeholder = state.pendingDelete
                      ? t('pendingDelete')
                      : isStored
                        ? t('storedSelectToOverwrite')
                        : field.default
                          ? t('notSetWithDefault', {
                              default: String(field.default),
                            })
                          : t('notSet');
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
                        className="min-w-0 flex-1 rounded-md border border-[color:var(--rule)] bg-[color:var(--bg)] px-3 py-2 text-[12px] text-[color:var(--ink)] focus:border-[color:var(--accent)] focus:outline-none disabled:opacity-50"
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
                    // OM-17 — the manifest's `placeholder` was parsed
                    // server-side and then thrown away here, overridden by
                    // state-derived text. It is the cheapest way to show the
                    // SHAPE of the expected value, so it now wins whenever
                    // there is nothing more urgent to say (no pending delete,
                    // nothing stored yet).
                    const placeholder = state.pendingDelete
                      ? t('pendingDelete')
                      : isStored
                        ? isSecret
                          ? t('storedRetypeToOverwrite')
                          : t('clearToDelete')
                        : (field.placeholder ?? t('notSetYet'));
                    return (
                      <input
                        type={isSecret ? 'password' : 'text'}
                        value={inputValue}
                        disabled={state.pendingDelete || saving}
                        aria-invalid={isInvalid || undefined}
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
                        className={`min-w-0 flex-1 rounded-md border bg-[color:var(--bg)] px-3 py-2 text-[12px] text-[color:var(--ink)] placeholder:text-[color:var(--faint-ink)] focus:outline-none disabled:opacity-50 ${
                          isInvalid
                            ? 'border-[color:var(--danger)] focus:border-[color:var(--danger)]'
                            : 'border-[color:var(--rule)] focus:border-[color:var(--accent)]'
                        }`}
                      />
                    );
                  })()
                )}
                {isStored && !isMultiselect ? (
                  // eslint-disable-next-line no-restricted-syntax -- icon-only chrome (size-7 trashcan, Trash2 icon only)
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
                        ? t('cancelDelete')
                        : isSecret
                          ? t('deleteSecretOnSave')
                          : t('deleteConfigOnSave')
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
        <Button
          variant="primary"
          onClick={() => void onSave()}
          disabled={saving || dirtyCount === 0 || invalidKeys.size > 0}
          busy={saving}
          busyLabel={
            dirtyCount > 0
              ? t('saveWithCount', { count: dirtyCount })
              : t('save')
          }
        >
          <CheckCircle2 className="size-3.5" aria-hidden />
          {dirtyCount > 0
            ? t('saveWithCount', { count: dirtyCount })
            : t('save')}
        </Button>
        {savedAt !== null ? (
          <span className="text-[11px] text-[color:var(--muted-ink)]">
            {t('savedCheck')}
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

/**
 * Spec 005 — Connect control for a `type:oauth` field. Renders the current
 * connection state plus a button that navigates to the kernel broker's
 * `/oauth/start` (a real top-level navigation through the `/bot-api` proxy, so
 * the middleware can 302 to the IdP). After consent the broker redirects back
 * to this store page with `?connected=ok|error`.
 */
function OAuthConnectField({
  pluginId,
  fieldKey,
  connected,
}: {
  pluginId: string;
  fieldKey: string;
  connected: boolean;
}): React.ReactElement {
  const t = useTranslations('store.credentials');
  const startUrl = `/bot-api/v1/install/oauth/start?pluginId=${encodeURIComponent(
    pluginId,
  )}&fieldKey=${encodeURIComponent(fieldKey)}`;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      {connected ? (
        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[color:var(--success)]">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {t('connected')}
        </span>
      ) : (
        <span className="text-[12px] text-[color:var(--muted-ink)]">
          {t('notConnected')}
        </span>
      )}
      <a
        href={startUrl}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-1.5 text-[12px] font-semibold text-[color:var(--accent)] transition-colors hover:bg-[color:var(--accent)]/20"
      >
        <Plug className="size-3.5" aria-hidden />
        {connected ? t('reconnect') : t('connect')}
      </a>
    </div>
  );
}

/** Parse the stored config value (a JSON-encoded `string[]`, or a tolerated
 *  legacy comma string) into the current selection. */
function parseStoredArray(raw: string | undefined): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (!t.startsWith('[')) {
    return t
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  try {
    const parsed: unknown = JSON.parse(t);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Post-install multiselect for a field that declares `options_provider`.
 * Fetches choices from the running plugin, renders grouped checkboxes, and
 * saves the selection via patchInstalledConfig (the array-capable path). When
 * the provider is inactive/failing (409/502/504), degrades to a comma-separated
 * free-text input so the operator is never blocked.
 */
function MultiselectField({
  pluginId,
  fieldKey,
  storedValue,
}: {
  pluginId: string;
  fieldKey: string;
  storedValue: string | undefined;
}): React.ReactElement {
  const t = useTranslations('store.credentials');
  const [selected, setSelected] = useState<string[]>([]);
  const [options, setOptions] = useState<SetupOption[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'degraded'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [freeText, setFreeText] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate the current selection from the stored value ONCE it arrives. The
  // parent fetches config values async, so `storedValue` is undefined on the
  // first render — initialising state from it directly would miss the value
  // (and the checkboxes would look empty after a reload). Guard with a ref so
  // we never clobber an in-progress edit if the parent re-fetches.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || storedValue === undefined) return;
    hydratedRef.current = true;
    const arr = parseStoredArray(storedValue);
    setSelected(arr);
    setFreeText(arr.join(', '));
  }, [storedValue]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const opts = await fetchSetupFieldOptions(pluginId, fieldKey);
      setOptions(opts);
      setStatus('loaded');
    } catch (err) {
      setError(humanizeError(err));
      setStatus('degraded');
    }
  }, [pluginId, fieldKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const toggle = (value: string): void =>
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const values =
        status === 'degraded'
          ? freeText
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : selected;
      await patchInstalledConfig(pluginId, { [fieldKey]: values });
      setSavedAt(Date.now());
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  }, [status, freeText, selected, pluginId, fieldKey]);

  const groups = useMemo(() => {
    const m = new Map<string, SetupOption[]>();
    for (const o of options ?? []) {
      const g = o.group ?? '';
      const arr = m.get(g) ?? [];
      arr.push(o);
      m.set(g, arr);
    }
    return Array.from(m.entries());
  }, [options]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {status === 'loading' ? (
        <span className="text-[12px] text-[color:var(--muted-ink)]">
          {t('loadingOptions')}
        </span>
      ) : status === 'degraded' ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[color:var(--muted-ink)]">
            {t('optionsUnavailable', {
              error: error ?? t('pluginInactive'),
            })}
          </span>
          <input
            type="text"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="id-1, id-2, …"
            className="min-w-0 rounded-md border border-[color:var(--rule)] bg-[color:var(--bg)] px-3 py-2 text-[12px] text-[color:var(--ink)] placeholder:text-[color:var(--faint-ink)] focus:border-[color:var(--accent)] focus:outline-none"
          />
        </div>
      ) : options && options.length > 0 ? (
        <div className="max-h-56 overflow-auto rounded-md border border-[color:var(--rule)] p-2">
          {groups.map(([group, opts]) => (
            <div key={group || '_'} className="mb-2 last:mb-0">
              {group ? (
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--faint-ink)]">
                  {group}
                </div>
              ) : null}
              {opts.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-[color:var(--ink)]"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(o.value)}
                    onChange={() => toggle(o.value)}
                    className="size-4 accent-[color:var(--accent)]"
                  />
                  <span className="truncate">{o.label}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <span className="text-[12px] text-[color:var(--muted-ink)]">
          {t('noEntries')}
        </span>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          onClick={() => void onSave()}
          disabled={saving}
          busy={saving}
          busyLabel={t('saving')}
        >
          <CheckCircle2 className="size-3.5" aria-hidden />
          {status !== 'degraded'
            ? t('saveSelectionWithCount', { count: selected.length })
            : t('saveSelection')}
        </Button>
        {savedAt !== null ? (
          <span className="text-[11px] text-[color:var(--muted-ink)]">
            {t('savedCheck')}
          </span>
        ) : null}
        {status === 'loaded' ? (
          // eslint-disable-next-line no-restricted-syntax -- inline text link (underlined bare text, no border/bg)
          <button
            type="button"
            onClick={() => void load()}
            className="text-[11px] text-[color:var(--muted-ink)] underline hover:text-[color:var(--accent)]"
          >
            {t('refreshList')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function humanizeError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as {
        code?: string;
        message?: string;
      };
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

/**
 * {@link humanizeError} plus the OM-17 field-level rejection, which only the
 * secrets PATCH can return.
 *
 * Prefers the manifest's own hint ("expects …@….iam.gserviceaccount.com") over
 * the generic `code: message` line, which tells the operator nothing
 * actionable — and resolves it from OUR copy of `pattern_hint`, not from
 * `body.hint`. The middleware has no request locale, so its hint is always
 * English and a German operator would read an English sentence: exactly the
 * English-in-a-German-UI confusion that was a named contributing factor of
 * OM-17. `body.hint` remains the fallback for a key we do not know about.
 *
 * @param setupFields the manifest fields this editor renders — the source of
 *   the localized `pattern_hint` map
 * @param locale      the active UI locale
 */
function humanizeSecretsPatchError(
  err: unknown,
  setupFields: ReadonlyArray<PluginSetupField>,
  locale: string,
): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as {
        code?: string;
        field?: string;
        hint?: string;
      };
      if (body.code === 'runtime.setup_field_invalid') {
        const hint = resolveSetupFieldHint(
          setupFields,
          body.field,
          body.hint,
          locale,
        );
        if (hint) return body.field ? `${body.field}: ${hint}` : hint;
      }
    } catch {
      // fall through to the generic handling
    }
  }
  return humanizeError(err);
}
