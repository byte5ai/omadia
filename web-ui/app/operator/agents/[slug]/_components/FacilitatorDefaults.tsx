'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { archetypeText } from '../../../../_lib/archetypes';
import {
  getArchetypeSettings,
  parseArchetypeSettingIssues,
  parseNumberListInput,
  saveArchetypeSettings,
  type ArchetypeSettingField,
  type ArchetypeSettings,
  type ArchetypeSettingValue,
} from '../../../../_lib/archetypeSettings';

/**
 * #2066 — a facilitator's default methods and reminder policy (spec 2043 §7,
 * §5.6). The fields are the ones the facilitator archetype plugin declares;
 * every field may stay unset, and then the plugin's instance setting applies,
 * which the form says next to the field. A facilitation can still state its
 * own reminders or method; these are only the defaults it starts from.
 */

type Draft = Readonly<Record<string, string>>;

const INSTANCE = '';

function draftOf(settings: ArchetypeSettings): Draft {
  return Object.fromEntries(
    settings.fields.map((f) => {
      const value = settings.values[f.key];
      if (value === undefined) return [f.key, INSTANCE];
      return [f.key, Array.isArray(value) ? value.join(', ') : String(value)];
    }),
  );
}

export function FacilitatorDefaults(props: { readonly slug: string }): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator.defaults');
  const locale = useLocale();
  const [settings, setSettings] = useState<ArchetypeSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await getArchetypeSettings(props.slug);
      setSettings(next);
      setDraft(draftOf(next));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [props.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadFailed) {
    return (
      <p role="alert" className="text-sm text-[color:var(--danger)]" data-testid="facilitator-defaults-load-failed">
        {t('loadFailed')}
      </p>
    );
  }
  if (!settings) {
    return <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>;
  }
  if (settings.fields.length === 0) {
    return (
      <p className="text-sm text-[color:var(--fg-muted)]" data-testid="facilitator-defaults-none">
        {t('none')}
      </p>
    );
  }

  const save = async (): Promise<void> => {
    const changes: Record<string, ArchetypeSettingValue | null> = {};
    const bad: string[] = [];
    for (const field of settings.fields) {
      const raw = (draft[field.key] ?? INSTANCE).trim();
      if (raw === INSTANCE) {
        changes[field.key] = null;
        continue;
      }
      if (field.type === 'enum') {
        changes[field.key] = raw;
        continue;
      }
      const list = parseNumberListInput(raw);
      if (!list || (field.max_items !== null && list.length > field.max_items)) bad.push(field.key);
      else changes[field.key] = list;
    }
    setInvalid(bad);
    if (bad.length > 0) return;
    setSaving(true);
    setStatus('idle');
    try {
      const next = await saveArchetypeSettings(props.slug, changes);
      setSettings(next);
      setDraft(draftOf(next));
      setStatus('saved');
    } catch (err: unknown) {
      const issues = parseArchetypeSettingIssues(err);
      if (issues) setInvalid(issues.map((i) => i.key));
      setStatus('failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="facilitator-defaults"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="text-sm font-medium">{t('heading')}</h3>
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>
      </div>
      {settings.fields.map((field) => (
        <SettingField
          key={field.key}
          field={field}
          locale={locale}
          value={draft[field.key] ?? INSTANCE}
          invalid={invalid.includes(field.key)}
          onChange={(value) => {
            setDraft((d) => ({ ...d, [field.key]: value }));
            setStatus('idle');
          }}
        />
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving} data-testid="facilitator-defaults-save">
          {saving ? t('saving') : t('save')}
        </Button>
        {status === 'saved' && (
          <span role="status" className="text-xs text-[color:var(--success)]">
            {t('saved')}
          </span>
        )}
        {status === 'failed' && (
          <span role="alert" className="text-xs text-[color:var(--danger)]">
            {t('saveFailed')}
          </span>
        )}
      </div>
    </form>
  );
}

function SettingField(props: {
  readonly field: ArchetypeSettingField;
  readonly locale: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly onChange: (value: string) => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator.defaults');
  const { field, locale, value, invalid, onChange } = props;
  const id = `facilitator-default-${field.key}`;
  const label = archetypeText(field.label, locale) ?? field.key;
  const help = archetypeText(field.help, locale);
  const inputClass =
    'mt-1 w-full max-w-md rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm';
  return (
    <div>
      <label htmlFor={id} className="block text-sm">
        {label}
      </label>
      {field.type === 'enum' ? (
        <select
          id={id}
          data-testid={id}
          className={inputClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t('instanceDefault')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {archetypeText(o.label, locale) ?? o.value}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          data-testid={id}
          className={inputClass}
          value={value}
          inputMode="decimal"
          placeholder={t('instanceDefault')}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help && <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{help}</p>}
      {invalid && (
        <p role="alert" className="mt-1 text-xs text-[color:var(--danger)]">
          {field.type === 'number_list'
            ? t('invalidList', { max: field.max_items ?? 10 })
            : t('invalidOption')}
        </p>
      )}
    </div>
  );
}
