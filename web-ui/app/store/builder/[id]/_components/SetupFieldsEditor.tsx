'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { Plus, Trash2 } from 'lucide-react';

import { ApiError, patchBuilderSpec } from '../../../../_lib/api';
import type {
  JsonPatch,
  SetupField,
} from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

interface SetupFieldsEditorProps {
  draftId: string;
  /** Server-canonical setup_fields. Re-renders flow through here via SSE
   *  + Workspace re-fetch. */
  fields: ReadonlyArray<SetupField>;
}

const FIELD_TYPES: ReadonlyArray<NonNullable<SetupField['type']>> = [
  'string',
  'secret',
  'url',
  'number',
  'boolean',
];

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Setup-Fields-Editor — declarative slot for credentials and runtime
 * config. Each entry in `spec.setup_fields` describes one input the
 * agent needs (API keys, group slugs, base URLs, …). The Test-Credentials
 * drawer in the Preview-Pane reads this list to render the form for the
 * in-memory PreviewSecretBuffer.
 *
 * Edits flow through PATCH /drafts/:id/spec — every change rewrites the
 * full `setup_fields` array (replace-on-path) so we don't have to manage
 * per-row JSON-Pointer indices that shift as the user adds and removes.
 */
export function SetupFieldsEditor({
  draftId,
  fields,
}: SetupFieldsEditorProps): React.ReactElement {
  const t = useTranslations('builder.spec.setupFields');
  const safeFields = useMemo<SetupField[]>(
    () => fields.filter((f): f is SetupField => f !== null && typeof f === 'object' && 'key' in f),
    [fields],
  );
  const [savingError, setSavingError] = useState<string | null>(null);

  const replace = useCallback(
    async (next: SetupField[]) => {
      setSavingError(null);
      try {
        const patch: JsonPatch = { op: 'replace', path: '/setup_fields', value: next };
        await patchBuilderSpec(draftId, [patch]);
      } catch (err) {
        setSavingError(humanizeApiError(err));
      }
    },
    [draftId],
  );

  const removeAt = useCallback(
    (i: number) => {
      const next = safeFields.slice();
      next.splice(i, 1);
      void replace(next);
    },
    [replace, safeFields],
  );

  const updateAt = useCallback(
    (i: number, patch: Partial<SetupField>) => {
      const current = safeFields[i];
      if (!current) return;
      const next = safeFields.slice();
      next[i] = { ...current, ...patch };
      void replace(next);
    },
    [replace, safeFields],
  );

  const addNew = useCallback(
    (entry: SetupField) => {
      void replace([...safeFields, entry]);
    },
    [replace, safeFields],
  );

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
          {safeFields.map((f, i) => (
            <SetupFieldRow
              key={`${f.key}-${String(i)}`}
              field={f}
              onChange={(patch) => updateAt(i, patch)}
              onRemove={() => removeAt(i)}
            />
          ))}
        </ul>
      )}
      <NewFieldForm
        existingKeys={safeFields.map((f) => f.key)}
        onSubmit={addNew}
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
  onChange,
  onRemove,
}: {
  field: SetupField;
  onChange: (patch: Partial<SetupField>) => void;
  onRemove: () => void;
}): React.ReactElement {
  const t = useTranslations('builder.spec.setupFields');
  const keyId = useId();
  const labelId = useId();
  return (
    <li className="rounded-md border border-[color:var(--divider)] bg-[color:var(--bg-soft)]/40 p-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[1.2fr_1fr_0.8fr_0.6fr_auto]">
        <div>
          <label
            htmlFor={keyId}
            className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]"
          >
            key
          </label>
          <input
            id={keyId}
            type="text"
            value={field.key}
            onChange={(e) => onChange({ key: e.target.value })}
            onBlur={(e) => {
              if (!KEY_PATTERN.test(e.target.value)) {
                // Revert visually — server rejects, this just hints.
                e.target.style.borderColor = 'var(--danger)';
              } else {
                e.target.style.borderColor = '';
              }
            }}
            className="font-mono-num mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor={labelId}
            className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]"
          >
            label
          </label>
          <input
            id={labelId}
            type="text"
            value={field.label ?? ''}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder={field.key}
            className="mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            type
          </label>
          <select
            value={field.type ?? 'string'}
            onChange={(e) =>
              onChange({ type: e.target.value as SetupField['type'] })
            }
            className="font-mono-num mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] focus:outline-none"
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            required
          </label>
          <label className="mt-1 inline-flex items-center gap-2 text-[12px] text-[color:var(--fg-strong)]">
            <input
              type="checkbox"
              checked={Boolean(field.required)}
              onChange={(e) => onChange({ required: e.target.checked })}
              className="size-3.5 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
            />
            <span className="font-mono-num text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
              {field.required ? t('required.on') : t('required.off')}
            </span>
          </label>
        </div>
        <div className="flex items-end justify-end">
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
        <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
          description
        </label>
        <input
          type="text"
          value={field.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder={t('descriptionPlaceholder')}
          className="mt-0.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[12px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)] focus:border-[color:var(--accent)] focus:outline-none"
        />
      </div>
    </li>
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
            type
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

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { code?: string; message?: string };
      if (body.code && body.message) return `${body.code}: ${body.message}`;
      if (body.message) return body.message;
    } catch {
      // ignore
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
