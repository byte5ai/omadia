'use client';

import { cn } from '../../_lib/cn';
import type { InstallSetupField } from '../../_lib/storeTypes';

/**
 * Setup-form building blocks shared between the inline Install drawer and
 * the multi-step RequiresWizard (S+8.5). Extracted from InstallButton.tsx
 * so the wizard renders identical inputs without code duplication — same
 * coercion rules, same secret/url/integer/enum/boolean handling.
 */

export function FieldRow({
  field,
  error,
  idPrefix = 'install-field',
}: {
  field: InstallSetupField;
  error?: string;
  idPrefix?: string;
}): React.ReactElement {
  const id = `${idPrefix}-${field.key}`;
  const common = cn(
    'w-full border bg-[color:var(--paper)] px-3 py-2 text-sm',
    'focus:outline-none focus:ring-1',
    error
      ? 'border-[color:var(--oxblood)] focus:border-[color:var(--oxblood)] focus:ring-[color:var(--oxblood)]'
      : 'border-[color:var(--rule-strong)] focus:border-[color:var(--ink)] focus:ring-[color:var(--rule-strong)]',
  );

  return (
    <div>
      <label
        htmlFor={id}
        className="flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-[color:var(--muted-ink)]"
      >
        <span>
          {field.label}
          {field.required ? (
            <span className="ml-1 text-[color:var(--oxblood)]">*</span>
          ) : null}
        </span>
        <span className="font-mono-num normal-case tracking-normal text-[color:var(--faint-ink)]">
          {field.type}
        </span>
      </label>

      <div className="mt-2">
        {field.type === 'boolean' ? (
          <label
            htmlFor={id}
            className="flex items-center gap-3 border border-[color:var(--rule-strong)] bg-[color:var(--paper)] px-3 py-2 text-sm"
          >
            <input
              id={id}
              name={field.key}
              type="checkbox"
              defaultChecked={field.default === true}
              className="size-4 accent-[color:var(--oxblood)]"
            />
            <span className="text-[color:var(--muted-ink)]">
              {field.help ?? 'Aktivieren'}
            </span>
          </label>
        ) : field.type === 'enum' ? (
          <select
            id={id}
            name={field.key}
            required={field.required}
            defaultValue={typeof field.default === 'string' ? field.default : ''}
            className={common}
          >
            {!field.required ? <option value="">(nicht setzen)</option> : null}
            {(field.enum ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : field.type === 'integer' ? (
          <input
            id={id}
            name={field.key}
            type="number"
            step={1}
            required={field.required}
            defaultValue={
              typeof field.default === 'number' ? String(field.default) : ''
            }
            className={common}
          />
        ) : (
          <input
            id={id}
            name={field.key}
            type={
              field.type === 'secret'
                ? 'password'
                : field.type === 'url'
                  ? 'url'
                  : 'text'
            }
            required={field.required}
            placeholder={
              field.type === 'url'
                ? 'https://…'
                : field.type === 'secret'
                  ? '••••••••'
                  : undefined
            }
            defaultValue={
              typeof field.default === 'string' ? field.default : ''
            }
            className={common}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>

      {field.help && field.type !== 'boolean' ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
          {field.help}
        </p>
      ) : null}
      {error ? (
        <p className="font-mono-num mt-1 text-[11px] text-[color:var(--oxblood)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Coerce raw `FormData` entries to the typed shape the install API
 * expects. Mirrors the middleware-side `coerce()` helper — we send
 * already-typed values so the server doesn't have to second-guess
 * what `"42"` (string) vs `42` (integer) means.
 */
export function extractValues(
  fields: InstallSetupField[],
  formData: FormData,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === 'boolean') {
      values[field.key] = formData.get(field.key) === 'on';
      continue;
    }
    const raw = formData.get(field.key);
    if (raw === null) continue;
    if (typeof raw !== 'string') continue;
    if (raw === '' && !field.required) continue;
    if (field.type === 'integer') {
      const n = Number(raw);
      values[field.key] = Number.isFinite(n) ? n : raw;
      continue;
    }
    values[field.key] = raw;
  }
  return values;
}
