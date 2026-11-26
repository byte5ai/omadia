'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { Plus, Trash2 } from 'lucide-react';

import { ApiError, getBuilderDraft, patchBuilderSpec } from '../../../../_lib/api';
import type {
  OAuthProvider,
  SetupField,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

interface SetupFieldsEditorProps {
  draftId: string;
  specUpdatedAt: number;
  /** Server-canonical setup_fields. Re-renders flow through here via SSE
   *  + Workspace re-fetch. */
  fields: ReadonlyArray<SetupField>;
  /** Spec 005 (#371) — declared `oauth_providers` descriptors. A `type:oauth`
   *  field's `provider` picks one by `id`; empty means none authored yet. */
  oauthProviders: ReadonlyArray<OAuthProvider>;
}

const FIELD_TYPES: ReadonlyArray<NonNullable<SetupField['type']>> = [
  'string',
  'secret',
  'url',
  'integer',
  'host_list',
  'boolean',
  'oauth',
];

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

type FieldUpdate = (field: SetupField) => SetupField | null;
type FieldRename = { rowId: string; from: string; to: string };
type FieldsEdit = (fields: SetupField[]) => {
  fields: SetupField[];
  rename?: FieldRename;
} | null;

/** Buffer text in the row and serialize committed changes against the saved draft. */
export function SetupFieldsEditor({
  draftId,
  specUpdatedAt,
  fields,
  oauthProviders,
}: SetupFieldsEditorProps): React.ReactElement {
  const t = useTranslations('builder.spec.setupFields');
  const [saved, setSaved] = useState<{ updatedAt: number; fields: SetupField[] } | null>(null);
  const safeFields = (saved && saved.updatedAt >= specUpdatedAt ? saved.fields : fields)
    .filter((field) => field && typeof field.key === 'string');
  const [savingError, setSavingError] = useState<string | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const [rowIds, setRowIds] = useState(new Map<string, string>());
  const [pendingRename, setPendingRename] = useState<FieldRename | null>(null);
  const fieldKeys = useRef(new Map<string, string>());
  const renamedCount = useRef(0);

  const saveEdit = useCallback((edit: FieldsEdit) => {
    const result = saveQueue.current.then(async () => {
      setSavingError(null);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const { draft } = await getBuilderDraft(draftId);
          const current = draft.spec.setup_fields ?? [];
          const next = edit(current);
          if (!next) {
            setSaved({ updatedAt: draft.updatedAt, fields: current });
            setSavingError(t('saveConflict'));
            return;
          }
          if (next.rename) setPendingRename(next.rename);
          try {
            const { draft: updated } = await patchBuilderSpec(draftId, [
              { op: 'replace', path: '/setup_fields', value: next.fields },
            ], current);
            if (next.rename) {
              const { rowId, from, to } = next.rename;
              fieldKeys.current.set(rowId, to);
              const reusableId = `renamed:${String(++renamedCount.current)}`;
              setRowIds((previous) => new Map(previous).set(from, reusableId).set(to, rowId));
            }
            setSaved({ updatedAt: updated.updatedAt, fields: updated.spec.setup_fields ?? [] });
            return;
          } catch (err) {
            if (!(err instanceof ApiError) || err.code !== 'builder.setup_fields_changed') throw err;
          } finally {
            if (next.rename) setPendingRename(null);
          }
        }
        setSavingError(t('saveConflict'));
      } catch {
        setSavingError(t('saveFailed'));
      }
    });
    saveQueue.current = result;
    return result;
  }, [draftId, t]);

  function updateField(rowId: string, displayedKey: string, edit: FieldUpdate): Promise<void> {
    return saveEdit((current) => {
      const key = fieldKeys.current.get(rowId) ?? displayedKey;
      const index = current.findIndex((field) => field?.key === key);
      if (index < 0) return null;
      const next = current.slice();
      const updated = edit(current[index]!);
      if (!updated || current.some((field, i) => i !== index && field?.key === updated.key)) return null;
      next[index] = updated;
      return { fields: next, ...(updated.key === key ? {} : { rename: { rowId, from: key, to: updated.key } }) };
    });
  }

  return (
    <div className="space-y-3">
      {safeFields.length === 0 ? (
        <p className="text-[12px] text-[color:var(--fg-muted)]">
          {t.rich('emptyState', {
            example: (chunks) => (
              <span className="font-mono-num">{chunks}</span>
            ),
          })}
        </p>
      ) : (
        <ul className="space-y-2">
          {safeFields.map((field) => {
            const rowId = pendingRename?.to === field.key && !safeFields.some(({ key }) => key === pendingRename.from)
              ? pendingRename.rowId
              : (rowIds.get(field.key) ?? `field:${field.key}`);
            return (
              <SetupFieldRow
                key={rowId}
                field={field}
                oauthProviders={oauthProviders}
                onChange={(edit) => updateField(rowId, field.key, edit)}
                onRemove={() => saveEdit((current) => {
                  const key = fieldKeys.current.get(rowId) ?? field.key;
                  const latest = current.find((item) => item?.key === key);
                  if (latest && JSON.stringify(latest) !== JSON.stringify({ ...field, key })) return null;
                  return { fields: current.filter((item) => item?.key !== key) };
                })}
              />
            );
          })}
        </ul>
      )}
      <NewFieldForm
        existingKeys={safeFields.map((f) => f.key)}
        onSubmit={(entry) => saveEdit((current) =>
          current.some((field) => field?.key === entry.key) ? null : { fields: [...current, entry] })}
      />
      {savingError ? (
        <p className="text-[11px] text-[color:var(--danger)]">{savingError}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SetupFieldRow({
  field,
  oauthProviders,
  onChange,
  onRemove,
}: {
  field: SetupField;
  oauthProviders: ReadonlyArray<OAuthProvider>;
  onChange: (edit: FieldUpdate) => Promise<void>;
  onRemove: () => void;
}): React.ReactElement {
  const t = useTranslations('builder.spec.setupFields');
  const language = useLocale().startsWith('de') ? 'de' : 'en';
  const typeId = useId();
  const providerId = useId();
  const update = (patch: Partial<SetupField>) => onChange((current) => {
    const changed = (Object.keys(patch) as Array<keyof SetupField>).some((key) =>
      JSON.stringify(current[key]) !== JSON.stringify(field[key]) &&
      JSON.stringify(current[key]) !== JSON.stringify(patch[key]),
    );
    return changed ? null : { ...current, ...patch };
  });
  const labelOf = (current: SetupField) => current.label_localized?.[language] ?? current.label ?? '';
  const helpOf = (current: SetupField) => current.help_localized?.[language] ?? current.help ?? current.description ?? '';
  const scopesOf = (current: SetupField) => (current.scopes ?? []).join(', ');
  return (
    <li className="rounded-md border border-[color:var(--divider)] bg-[color:var(--bg-soft)]/40 p-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[1.2fr_1fr_0.8fr_0.6fr_auto]">
        <BufferedField
          label={t('fieldKey')}
          value={field.key}
          validate={(key) => KEY_PATTERN.test(key) ? undefined : t('validation.keyFormat')}
          onCommit={(key, base) => onChange((current) => current.key === base ? { ...current, key } : null)}
          mono
        />
        <BufferedField
          label={t('fieldLabel')}
          value={labelOf(field)}
          placeholder={field.key}
          normalize={(label) => label.trim() || field.label_localized?.[language === 'de' ? 'en' : 'de'] || ''}
          onCommit={(label, base) => onChange((current) => {
            if (labelOf(current) !== base && labelOf(current) !== label) return null;
            const other = language === 'de' ? 'en' : 'de';
            const fallback = current.label_localized?.[other] ?? current.label?.trim() ?? '';
            const edited = label.trim();
            const text = edited || fallback;
            if (!edited && !current.label_localized) return { ...current, label: undefined };
            return {
              ...current,
              label_localized: { en: text, de: text, [other]: fallback || text },
            };
          })}
        />
        <div>
          <label htmlFor={typeId} className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            {t('fieldType')}
          </label>
          <select
            id={typeId}
            value={field.type ?? 'string'}
            onChange={(e) => {
              const nextType = e.target.value as SetupField['type'];
              // provider/scopes belong to type:oauth only — clear them when
              // switching away so we never emit a field the linter rejects.
              update(
                nextType === 'oauth'
                  ? { type: nextType }
                  : { type: nextType, provider: undefined, scopes: undefined },
              );
            }}
            className="font-mono-num mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
          >
            {field.type && !FIELD_TYPES.includes(field.type) && <option value={field.type}>{field.type}</option>}
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            {t('fieldRequired')}
          </label>
          <label className="mt-1 inline-flex items-center gap-2 text-[12px] text-[color:var(--fg-strong)]">
            <input
              type="checkbox"
              checked={Boolean(field.required)}
              onChange={(e) => update({ required: e.target.checked })}
              className="size-3.5 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
            />
            <span className="font-mono-num text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
              {field.required ? t('required.on') : t('required.off')}
            </span>
          </label>
        </div>
        <div className="flex items-end justify-end">
          {/* eslint-disable-next-line no-restricted-syntax -- icon-only remove control (Trash2 glyph, no text label) */}
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('removeAria', { key: field.key })}
            className="rounded-md p-2 text-[color:var(--fg-muted)] hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)]"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
      <div className="mt-2">
        <BufferedField
          label={t('fieldDescription')}
          value={helpOf(field)}
          placeholder={t('descriptionPlaceholder')}
          normalize={field.help_localized ? (text) =>
            text.trim() || field.help_localized?.[language === 'de' ? 'en' : 'de'] || '' : undefined}
          onCommit={(description, base) => onChange((current) => {
            if (helpOf(current) !== base && helpOf(current) !== description) return null;
            if (!current.help_localized && !current.help) return { ...current, description };
            if (!current.help_localized) return { ...current, help: description };
            const other = language === 'de' ? 'en' : 'de';
            const text = description.trim() || current.help_localized[other];
            return { ...current, help_localized: { ...current.help_localized, [language]: text } };
          })}
        />
      </div>
      {field.type === 'oauth' ? (
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          <div>
            <label
              htmlFor={providerId}
              className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]"
            >
              {t('oauth.provider')}
            </label>
            {oauthProviders.length > 0 ? (
              <select
                id={providerId}
                value={field.provider ?? ''}
                onChange={(e) =>
                  update({ provider: e.target.value || undefined })
                }
                className="font-mono-num mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
              >
                <option value="">{t('oauth.selectProvider')}</option>
                {oauthProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-0.5 text-[11px] text-[color:var(--fg-muted)]">
                {t('oauth.noProviders')}
              </p>
            )}
          </div>
          <BufferedField
            label={t('oauth.scopes')}
            value={scopesOf(field)}
            normalize={(text) => text.split(',').map((scope) => scope.trim()).filter(Boolean).join(', ')}
            onCommit={(text, base) => onChange((current) => {
              if (current.type !== 'oauth' || (scopesOf(current) !== base && scopesOf(current) !== text)) return null;
              const scopes = text.split(',').map((scope) => scope.trim()).filter(Boolean);
              return { ...current, scopes: scopes.length > 0 ? scopes : undefined };
            })}
            placeholder={t('oauth.scopesPlaceholder')}
            mono
          />
        </div>
      ) : null}
    </li>
  );
}

function BufferedField({
  label,
  value,
  onCommit,
  placeholder,
  validate,
  normalize,
  mono,
}: {
  label: string;
  value: string;
  onCommit: (text: string, base: string) => Promise<void>;
  placeholder?: string;
  validate?: (text: string) => string | undefined;
  normalize?: (text: string) => string;
  mono?: boolean;
}): React.ReactElement {
  const id = useId();
  const [edit, setEdit] = useState<{ text: string; base: string } | null>(null);
  const lastSubmission = useRef<{ text: string } | null>(null);
  const text = edit?.text ?? value;
  const error = validate?.(text);
  return (
    <div>
      <label htmlFor={id} className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const text = e.target.value;
          const base = lastSubmission.current?.text ?? value;
          setEdit((previous) => ({ text, base: previous?.base ?? base }));
        }}
        onBlur={() => {
          if (!edit || error) return;
          const normalized = normalize?.(edit.text) ?? edit.text;
          if (normalized === edit.base) {
            setEdit(null);
            return;
          }
          const submission = { text: normalized };
          const submittedEdit = { text: edit.text, base: normalized };
          lastSubmission.current = submission;
          setEdit(submittedEdit);
          void onCommit(edit.text, edit.base).then(() => {
            if (lastSubmission.current !== submission) return;
            lastSubmission.current = null;
            setEdit((current) => current === submittedEdit ? null : current);
          });
        }}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(
          'mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none',
          mono && 'font-mono-num',
        )}
      />
      {error && <p id={`${id}-error`} className="mt-1 text-[10px] text-[color:var(--danger)]">{error}</p>}
    </div>
  );
}

function NewFieldForm({
  existingKeys,
  onSubmit,
}: {
  existingKeys: ReadonlyArray<string>;
  onSubmit: (field: SetupField) => void;
}): React.ReactElement {
  const t = useTranslations('builder.spec.setupFields');
  const [key, setKey] = useState('');
  const [type, setType] = useState<NonNullable<SetupField['type']>>('string');
  const [required, setRequired] = useState(false);

  const trimmed = key.trim();
  const valid =
    trimmed.length > 0 &&
    KEY_PATTERN.test(trimmed) &&
    !existingKeys.includes(trimmed);

  return (
    <div className="rounded-md border border-dashed border-[color:var(--divider)] bg-[color:var(--bg-soft)]/30 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1">
          <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            {t('newKey')}
          </label>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) {
                onSubmit({ key: trimmed, type, required });
                setKey('');
                setRequired(false);
              }
            }}
            placeholder={t('newKeyPlaceholder')}
            className={cn(
              'font-mono-num mt-0.5 w-full rounded-md border bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)] focus:outline-none',
              !key || valid
                ? 'border-[color:var(--border)] focus:border-[color:var(--accent)]'
                : 'border-[color:var(--danger)]/60',
            )}
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            {t('fieldType')}
          </label>
          <select
            value={type}
            onChange={(e) =>
              setType(e.target.value as NonNullable<SetupField['type']>)
            }
            className="font-mono-num mt-0.5 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <label className="mt-4 inline-flex items-center gap-2 text-[11px] text-[color:var(--fg-strong)]">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="size-3.5 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
          />
          <span className="font-mono-num text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            {t('required.on')}
          </span>
        </label>
        <Button
          variant="primary"
          onClick={() => {
            if (!valid) return;
            onSubmit({ key: trimmed, type, required });
            setKey('');
            setRequired(false);
          }}
          disabled={!valid}
          className="ml-auto gap-1 text-[11px]"
        >
          <Plus className="size-3" aria-hidden />
          {t('add')}
        </Button>
      </div>
      {key && !valid ? (
        <p className="mt-1 text-[10px] text-[color:var(--danger)]">
          {existingKeys.includes(trimmed)
            ? t('validation.keyExists')
            : t('validation.keyFormat')}
        </p>
      ) : null}
    </div>
  );
}
