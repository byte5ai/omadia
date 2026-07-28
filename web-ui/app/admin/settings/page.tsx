'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  getSettings,
  patchSettings,
  type ResolvedSetting,
  type SettingsCategory,
} from '../../_lib/api';

/**
 * The plugins whose settings used to live on this page and now live with each
 * plugin (edited via its own panel at `/store/<id>`, driven by the plugin's
 * manifest setup.fields). Shown as a directory so operators can jump straight
 * to the right editor. `labelKey` resolves under `adminSettings.pluginDirectory.plugins`.
 */
const PLUGIN_DIRECTORY: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: '@omadia/orchestrator', labelKey: 'orchestrator' },
  { id: '@omadia/verifier', labelKey: 'verifier' },
  { id: '@omadia/embeddings', labelKey: 'embeddings' },
  { id: '@omadia/knowledge-graph-neon', labelKey: 'knowledgeGraph' },
  { id: '@omadia/diagrams', labelKey: 'diagrams' },
];

/**
 * Operator settings overview — every .env-based value that bootstrap writes
 * into the runtime config-store / secret vault, grouped and editable. Backend:
 * GET/PATCH /api/v1/admin/settings (via the /bot-api proxy). Changes auto-save
 * after a short debounce and the affected plugin is re-activated server-side,
 * so they take effect live — no restart. Secrets show set/unset only; their
 * stored value is never returned. Labels resolve from the i18n catalog under
 * `adminSettings`.
 */

type FieldStatus = 'idle' | 'saving' | 'saved' | 'error';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; categories: SettingsCategory[]; vaultAvailable: boolean }
  | { kind: 'error'; message: string };

export default function AdminSettingsPage(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Local draft values for non-secret + secret inputs, keyed by setting key.
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, FieldStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const t = useTranslations('adminSettings');
  const tDir = useTranslations('adminSettings.pluginDirectory');

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await getSettings();
      const seed: Record<string, string> = {};
      for (const c of res.categories) {
        for (const s of c.settings) {
          if (s.type !== 'secret') seed[s.key] = s.value ?? '';
        }
      }
      setValues(seed);
      setState({
        kind: 'ready',
        categories: res.categories,
        vaultAvailable: res.vault_available,
      });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyUpdated = useCallback((updated: ResolvedSetting): void => {
    setState((prev) =>
      prev.kind === 'ready'
        ? {
            ...prev,
            categories: prev.categories.map((c) => ({
              ...c,
              settings: c.settings.map((s) =>
                s.key === updated.key ? updated : s,
              ),
            })),
          }
        : prev,
    );
  }, []);

  const save = useCallback(
    async (key: string, value: string | null): Promise<void> => {
      setStatus((s) => ({ ...s, [key]: 'saving' }));
      setErrors((e) => {
        const n = { ...e };
        delete n[key];
        return n;
      });
      try {
        const res = await patchSettings([{ key, value }]);
        const fieldErr = res.errors.find((er) => er.key === key);
        if (fieldErr) {
          setStatus((s) => ({ ...s, [key]: 'error' }));
          setErrors((e) => ({ ...e, [key]: fieldErr.message }));
          return;
        }
        const upd = res.updated.find((u) => u.key === key);
        if (upd) applyUpdated(upd);
        // Secret drafts are one-shot — clear the input after a successful save.
        if (upd?.type === 'secret') {
          setValues((v) => ({ ...v, [key]: '' }));
        }
        setStatus((s) => ({ ...s, [key]: 'saved' }));
      } catch (err) {
        setStatus((s) => ({ ...s, [key]: 'error' }));
        setErrors((e) => ({
          ...e,
          [key]: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [applyUpdated],
  );

  const debouncedSave = useCallback(
    (key: string, value: string | null): void => {
      const existing = timers.current[key];
      if (existing) clearTimeout(existing);
      timers.current[key] = setTimeout(() => {
        void save(key, value);
      }, 700);
    },
    [save],
  );

  const onText = useCallback(
    (s: ResolvedSetting, raw: string): void => {
      setValues((v) => ({ ...v, [s.key]: raw }));
      setStatus((st) => ({ ...st, [s.key]: 'idle' }));
      if (s.type === 'secret') {
        // Only auto-save a non-empty secret draft; empty means "leave as is".
        if (raw.trim().length > 0) debouncedSave(s.key, raw);
        return;
      }
      debouncedSave(s.key, raw.length === 0 ? null : raw);
    },
    [debouncedSave],
  );

  const onImmediate = useCallback(
    (key: string, value: string | null): void => {
      setValues((v) => ({ ...v, [key]: value ?? '' }));
      void save(key, value);
    },
    [save],
  );

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t.rich('intro', {
            envFile: () => (
              <code className="rounded bg-[color:var(--card)] px-1 py-0.5 text-[12px]">.env</code>
            ),
          })}
        </p>
      </header>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">{t('loadError', { message: state.message })}</p>
      ) : (
        <div className="flex flex-col gap-8">
          {!state.vaultAvailable && (
            <p className="rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-4 py-3 text-sm text-[color:var(--warning)]">
              {t('vaultUnavailable')}
            </p>
          )}
          {state.categories.map((cat) => (
            <section key={cat.category}>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
                {cat.category}
              </h2>
              <ul className="flex flex-col gap-3">
                {cat.settings.map((s) => (
                  <li
                    key={s.key}
                    className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
                  >
                    <SettingRow
                      setting={s}
                      value={values[s.key] ?? ''}
                      status={status[s.key] ?? 'idle'}
                      error={errors[s.key]}
                      onText={onText}
                      onImmediate={onImmediate}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <section className="mt-12 border-t border-[color:var(--border)] pt-8">
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {tDir('heading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] leading-[1.55] text-[color:var(--fg-muted)]">
          {tDir('intro')}
        </p>
        <ul className="flex flex-col gap-2">
          {PLUGIN_DIRECTORY.map((p) => (
            <li key={p.id}>
              <Link
                href={`/store/${encodeURIComponent(p.id)}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 px-4 py-4 transition-colors hover:bg-[color:var(--card)]"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
                    {tDir(`plugins.${p.labelKey}`)}
                  </span>
                  <code className="text-[11px] text-[color:var(--fg-muted)]">
                    {p.id}
                  </code>
                </span>
                <span className="text-[13px] font-medium text-[color:var(--accent)]">
                  {tDir('open')} →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)] disabled:opacity-50';

function SettingRow({
  setting: s,
  value,
  status,
  error,
  onText,
  onImmediate,
}: {
  setting: ResolvedSetting;
  value: string;
  status: FieldStatus;
  error?: string;
  onText: (s: ResolvedSetting, raw: string) => void;
  onImmediate: (key: string, value: string | null) => void;
}): React.ReactElement {
  const t = useTranslations('adminSettings');
  const disabled = !s.installed;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
            {s.label}
          </span>
          <code className="text-[11px] text-[color:var(--fg-muted)]">{s.key}</code>
          {!s.installed && (
            <span className="rounded-full bg-[color:var(--border)]/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('notInstalled')}
            </span>
          )}
        </div>
        <StatusChip status={status} />
      </div>

      {s.type === 'boolean' ? (
        <select
          value={value || 'false'}
          disabled={disabled}
          onChange={(e) => onImmediate(s.key, e.target.value)}
          className={`${inputCls} sm:max-w-[200px]`}
        >
          <option value="true">{t('boolean.on')}</option>
          <option value="false">{t('boolean.off')}</option>
        </select>
      ) : s.type === 'enum' ? (
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onImmediate(s.key, e.target.value)}
          className={`${inputCls} sm:max-w-[320px]`}
        >
          {(s.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : s.type === 'secret' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={[
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
              s.isSet
                ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
                : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
            ].join(' ')}
          >
            {s.isSet ? t('secret.set') : t('secret.unset')}
          </span>
          <input
            type="password"
            value={value}
            disabled={disabled}
            placeholder={s.isSet ? t('secret.replacePlaceholder') : (s.placeholder ?? t('secret.enterPlaceholder'))}
            onChange={(e) => onText(s, e.target.value)}
            className={`${inputCls} flex-1 sm:min-w-[260px]`}
          />
          {s.isSet && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => onImmediate(s.key, null)}
            >
              {t('secret.remove')}
            </Button>
          )}
        </div>
      ) : (
        <input
          type={s.type === 'number' ? 'number' : 'text'}
          value={value}
          disabled={disabled}
          placeholder={s.placeholder ?? ''}
          onChange={(e) => onText(s, e.target.value)}
          className={`${inputCls} sm:max-w-[420px]`}
        />
      )}

      {s.help && (
        <p className="text-[12px] leading-[1.5] text-[color:var(--fg-muted)]">
          {s.help}
        </p>
      )}
      {error && <p className="text-[12px] text-[color:var(--danger)]">{error}</p>}
    </div>
  );
}

function StatusChip({ status }: { status: FieldStatus }): React.ReactElement | null {
  const t = useTranslations('adminSettings.status');
  if (status === 'idle') return null;
  const map: Record<Exclude<FieldStatus, 'idle'>, { labelKey: string; cls: string }> = {
    saving: { labelKey: 'saving', cls: 'text-[color:var(--fg-muted)]' },
    saved: { labelKey: 'saved', cls: 'text-[color:var(--success)]' },
    error: { labelKey: 'error', cls: 'text-[color:var(--danger)]' },
  };
  const { labelKey, cls } = map[status];
  return <span className={`text-[11px] ${cls}`}>{t(labelKey)}</span>;
}
