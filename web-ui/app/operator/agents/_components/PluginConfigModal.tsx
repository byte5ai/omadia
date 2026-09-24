'use client';

import { KeyRound, RotateCcw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { pickLocalized } from '@/app/_lib/localized';
import type {
  PluginCatalogEntryDto,
  PluginSetupFieldDto,
} from '../../../_lib/agents';

/**
 * Per-(orchestrator × plugin) config editor, in the same row schema the store's
 * `CredentialsEditor` uses: identity on the left (key · type · storage class ·
 * label · help), the control on the right, and a status line that says where
 * the effective value comes from.
 *
 * Why a modal and not the old inline drawer: the drawer rendered every setup
 * field into a two-column grid inside one half of a drag-and-drop column. The
 * Odoo connector declares 24 fields, so the drawer pushed the whole tile list
 * off-screen and — because the help text was concatenated INTO the uppercase
 * label — turned a form into a wall of shouted prose. A dialog gets the full
 * viewport width, keeps the tile list stable, and lets long help text render as
 * ordinary sentence-case body copy under its label.
 *
 * Values live in `PluginsDnd`'s local selection map; this component only reads
 * them and reports edits upward. Nothing here talks to the server — the
 * enclosing "Speichern" ships the whole plugin set in one PUT, which is why the
 * footer says so explicitly.
 */

const RESET_HINT_FIELD_COUNT = 8;

interface PluginConfigModalProps {
  readonly entry: PluginCatalogEntryDto;
  readonly values: Record<string, unknown>;
  readonly disabled: boolean;
  readonly onChange: (
    key: string,
    value: string | boolean | number | string[],
  ) => void;
  /** Drop the key entirely so the store-level config wins again. */
  readonly onReset: (key: string) => void;
  readonly onResetAll: () => void;
  readonly onClose: () => void;
}

/**
 * A field counts as overridden when the orchestrator's own config map carries
 * the key at all — an explicit empty string is still an override of whatever
 * the store config holds, so presence and not truthiness is the test.
 */
export function isOverridden(
  values: Record<string, unknown>,
  key: string,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(values, key) &&
    values[key] !== undefined
  );
}

/** How many of a plugin's declared fields this orchestrator overrides. */
export function countOverrides(
  fields: readonly PluginSetupFieldDto[],
  values: Record<string, unknown>,
): number {
  return fields.filter((f) => isOverridden(values, f.key)).length;
}

export function PluginConfigModal({
  entry,
  values,
  disabled,
  onChange,
  onReset,
  onResetAll,
  onClose,
}: PluginConfigModalProps): React.ReactElement {
  const t = useTranslations('operatorAgents.pluginConfig');
  const locale = useLocale();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const fields = entry.setup_fields;
  const overrideCount = countOverrides(fields, values);

  // Match against everything the operator can actually see in a row, so
  // searching "openregister" finds the group and searching "Rate" finds the
  // labelled field regardless of which of the two the manifest spells out.
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return fields;
    return fields.filter((f) => {
      const label = pickLocalized(f.label, locale) ?? '';
      const help = pickLocalized(f.help, locale) ?? '';
      return `${f.key} ${label} ${help}`.toLowerCase().includes(needle);
    });
  }, [fields, filter, locale]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title', { plugin: entry.name })}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[color:var(--bg-modal-overlay)] p-4 sm:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] shadow-lg">
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">
              {t('title', { plugin: entry.name })}
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-[color:var(--fg-muted)]">
              {entry.id}
              {' · v'}
              {entry.version}
            </p>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- icon-only chrome (✕ close glyph) */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="shrink-0 text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            ✕
          </button>
        </header>

        {/* Config check — what this orchestrator actually overrides, and what
            silently falls through to the store-level install config. Without
            this line an empty input is ambiguous: unset, or set to empty? */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color:var(--border)] bg-[color:var(--bg-soft)]/50 px-5 py-3">
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
              overrideCount > 0
                ? 'bg-[color:var(--accent)]/12 text-[color:var(--accent)]'
                : 'bg-[color:var(--border)]/50 text-[color:var(--fg-muted)]'
            }`}
          >
            {t('overrideSummary', {
              set: overrideCount,
              total: fields.length,
            })}
          </span>
          <p className="text-[11px] text-[color:var(--fg-muted)]">
            {overrideCount > 0 ? t('introMixed') : t('introAllFromStore')}
          </p>
          {overrideCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={onResetAll}
              className="ml-auto"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {t('resetAll')}
            </Button>
          )}
        </div>

        {fields.length > RESET_HINT_FIELD_COUNT && (
          <div className="border-b border-[color:var(--border)] px-5 py-3">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('filterPlaceholder')}
              aria-label={t('filterPlaceholder')}
              className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-xs text-[color:var(--fg)] placeholder:text-[color:var(--fg-subtle)] focus:border-[color:var(--accent)] focus:outline-none"
            />
          </div>
        )}

        {visible.length === 0 ? (
          <p className="px-5 py-8 text-center text-xs text-[color:var(--fg-muted)]">
            {t('filterEmpty')}
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--border)] px-5">
            {visible.map((field) => (
              <PluginConfigRow
                key={field.key}
                field={field}
                value={values[field.key]}
                overridden={isOverridden(values, field.key)}
                disabled={disabled}
                onChange={(v) => onChange(field.key, v)}
                onReset={() => onReset(field.key)}
              />
            ))}
          </ul>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--border)] px-5 py-4">
          <p className="text-[11px] text-[color:var(--fg-muted)]">
            {t('unsavedHint')}
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('done')}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function PluginConfigRow(props: {
  field: PluginSetupFieldDto;
  value: unknown;
  overridden: boolean;
  disabled: boolean;
  onChange: (value: string | boolean | number | string[]) => void;
  onReset: () => void;
}): React.ReactElement {
  const { field, value, overridden, disabled, onChange, onReset } = props;
  const t = useTranslations('operatorAgents.pluginConfig');
  const locale = useLocale();
  // #602 (OM-17) — `label` / `help` arrive as `{ <locale>: text }` maps from
  // the manifest loader. Rendering the map object straight into JSX threw
  // React #31 and replaced the whole orchestrator page with the route error
  // boundary the moment "Config" was clicked. `key` is the loader's own
  // fallback for a label-less field, so it is the right last resort here too.
  const label = pickLocalized(field.label, locale) ?? field.key;
  const help = pickLocalized(field.help, locale);
  const isSecret = field.type === 'secret' || field.type === 'password';
  const defaultText =
    typeof field.default === 'string'
      ? field.default
      : Array.isArray(field.default)
        ? field.default.join(', ')
        : undefined;

  return (
    <li className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <KeyRound
            className="size-3.5 shrink-0 self-center text-[color:var(--fg-subtle)]"
            aria-hidden
          />
          <span className="font-mono text-[12px] text-[color:var(--fg)]">
            {field.key}
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
            {field.type}
          </span>
          {/* Storage classification, same split the store editor draws: a
              secret goes to the encrypted vault, everything else is plain
              instance config. Operators read "credentials" into every masked
              box otherwise. */}
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
              isSecret
                ? 'bg-[color:var(--accent)]/12 text-[color:var(--accent)]'
                : 'bg-[color:var(--border)]/50 text-[color:var(--fg-muted)]'
            }`}
            title={isSecret ? t('badgeSecretTitle') : t('badgeConfigTitle')}
          >
            {isSecret ? t('badgeSecret') : t('badgeConfig')}
          </span>
        </div>
        <div className="mt-1 text-[12px] font-medium text-[color:var(--fg)]">
          {label}
        </div>
        {help && (
          <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--fg-muted)]">
            {help}
          </p>
        )}
        {isSecret && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium leading-relaxed text-[color:var(--warning)]">
            <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{t('noPasswordWarning')}</span>
          </p>
        )}
      </div>

      <div className="flex w-full shrink-0 flex-col gap-1 sm:w-72">
        <div className="flex items-start gap-2">
          <PluginConfigControl
            field={field}
            value={value}
            disabled={disabled}
            placeholder={defaultText ?? t('notSet')}
            onChange={onChange}
          />
          {overridden && (
            // eslint-disable-next-line no-restricted-syntax -- icon-only chrome (size-7 revert glyph)
            <button
              type="button"
              onClick={onReset}
              disabled={disabled}
              title={t('reset')}
              aria-label={t('reset')}
              className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--border)] text-[color:var(--fg-muted)] transition-colors hover:border-[color:var(--accent)]/40 hover:text-[color:var(--accent)] disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        <span
          className={`text-[10px] ${
            overridden
              ? 'text-[color:var(--accent)]'
              : 'text-[color:var(--fg-subtle)]'
          }`}
        >
          {overridden
            ? t('statusOverridden')
            : defaultText
              ? t('statusFromStoreWithDefault', { default: defaultText })
              : t('statusFromStore')}
        </span>
      </div>
    </li>
  );
}

const CONTROL_CLASS =
  'min-w-0 flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-xs text-[color:var(--fg)] placeholder:text-[color:var(--fg-subtle)] focus:border-[color:var(--accent)] focus:outline-none disabled:opacity-50';

function PluginConfigControl(props: {
  field: PluginSetupFieldDto;
  value: unknown;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string | boolean | number | string[]) => void;
}): React.ReactElement {
  const { field, value, disabled, placeholder, onChange } = props;

  if (field.type === 'enum' && (field.enum?.length ?? 0) > 0) {
    return (
      <select
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={CONTROL_CLASS}
      >
        <option value="">{placeholder}</option>
        {field.enum?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true || value === 'true'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-2 size-4 accent-[color:var(--accent)]"
      />
    );
  }

  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={
          typeof value === 'number'
            ? value
            : value === undefined || value === ''
              ? ''
              : Number(value)
        }
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(e.target.value === '' ? 0 : Number(e.target.value))
        }
        className={CONTROL_CLASS}
      />
    );
  }

  if (field.type === 'host_list') {
    return (
      <textarea
        value={
          Array.isArray(value)
            ? value.join('\n')
            : typeof value === 'string'
              ? value
              : ''
        }
        disabled={disabled}
        rows={3}
        placeholder="hostname.example.com"
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
        className={`${CONTROL_CLASS} font-mono`}
      />
    );
  }

  const isSecret = field.type === 'secret' || field.type === 'password';
  return (
    <input
      type={isSecret ? 'password' : field.type === 'url' ? 'url' : 'text'}
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      autoComplete={isSecret ? 'off' : undefined}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={CONTROL_CLASS}
    />
  );
}
