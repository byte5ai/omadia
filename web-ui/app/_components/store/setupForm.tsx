'use client';

import { ShieldAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { cn } from '../../_lib/cn';
import { pickLocalized } from '../../_lib/localized';
import { nativePatternAttribute } from '../../_lib/setupFieldPattern';
import type { InstallSetupField } from '../../_lib/storeTypes';

/**
 * Setup-form building blocks shared between the inline Install drawer and
 * the multi-step RequiresWizard (S+8.5). Extracted from InstallButton.tsx
 * so the wizard renders identical inputs without code duplication — same
 * coercion rules, same secret/url/integer/enum/boolean handling.
 */

/**
 * One server-side validation failure for one field, as the install API reports
 * it (`details: [{ key, code, message }]`).
 *
 * The `code` is carried through — rather than flattening to the message string
 * on arrival — so this component can tell a `pattern_mismatch` apart from the
 * other codes. It has to: for a pattern mismatch the server's `message` IS the
 * manifest's `pattern_hint`, resolved to English because the middleware has no
 * request locale. We hold the whole localized map and render it under this very
 * input, so we can do better. See `resolveSetupFieldHint`.
 */
export interface SetupFieldError {
  code?: string;
  message: string;
}

export function FieldRow({
  field,
  error,
  idPrefix = 'install-field',
}: {
  field: InstallSetupField;
  error?: SetupFieldError;
  idPrefix?: string;
}): React.ReactElement {
  const t = useTranslations('store.setupForm');
  const locale = useLocale();
  const id = `${idPrefix}-${field.key}`;
  const patternHint = pickLocalized(field.pattern_hint, locale);
  // OM-17 — a German operator must not read an English rejection. Only the
  // pattern code is overridden: every other install error is either already a
  // catalog string or a value-shape message the manifest cannot explain.
  const errorText =
    error === undefined
      ? undefined
      : error.code === 'pattern_mismatch' && patternHint
        ? patternHint
        : error.message;
  // OM-17 — honour the manifest placeholder. The hardcoded `••••••••` told the
  // operator only "this is masked", which is exactly the signal that reads as
  // "type your password here". A manifest that says what shape it wants gets to
  // say it; only the fallback stays masked.
  const secretPlaceholder = field.placeholder ?? '••••••••';
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
              {field.help ?? t('enable')}
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
            {!field.required ? (
              <option value="">{t('dontSet')}</option>
            ) : null}
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
        ) : field.multiline &&
          (field.type === 'string' || field.type === 'secret') ? (
          <textarea
            id={id}
            name={field.key}
            rows={6}
            required={field.required}
            placeholder={
              field.type === 'secret' ? secretPlaceholder : field.placeholder
            }
            defaultValue={
              typeof field.default === 'string' ? field.default : ''
            }
            className={cn(common, 'resize-y font-mono text-xs leading-relaxed')}
            autoComplete="off"
            spellCheck={false}
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
            // OM-17 — client-side mirror of the server's `pattern` check. The
            // server is the load-bearing half (it owns the vault write); this
            // makes the browser refuse the submit before the round trip.
            //
            // `nativePatternAttribute` (NOT `field.pattern`) because the browser
            // implicitly anchors the attribute as `^(?:…)$`. For a HALF-anchored
            // pattern that is stricter than what the server enforces, and it
            // would block the submit of a perfectly valid value — e.g. the
            // prefix check `^-----BEGIN [A-Z ]*PRIVATE KEY-----` against a real
            // multi-line PEM block. In that case we emit no attribute and let
            // the authority decide.
            pattern={nativePatternAttribute(field.pattern)}
            title={patternHint}
            placeholder={
              field.placeholder ??
              (field.type === 'url'
                ? 'https://…'
                : field.type === 'secret'
                  ? secretPlaceholder
                  : undefined)
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

      {/* OM-17 — unconditional caution under EVERY secret input, in both
          renderers. A customer typed their real Google account password into a
          masked field that wanted a service-account private key, and the system
          accepted it silently. omadia never asks for an account password. */}
      {field.type === 'secret' ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium leading-relaxed text-[color:var(--warning)]">
          <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{t('noPasswordWarning')}</span>
        </p>
      ) : null}
      {patternHint ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--muted-ink)]">
          {patternHint}
        </p>
      ) : null}
      {/* OM-17 — the manifest asked for a format check and the server refused
          the regex, so this field is going UNCHECKED. Fail-open is right for
          the write; failing SILENT is what let a Google account password into a
          private-key field in the first place. */}
      {field.pattern_unavailable ? (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-[color:var(--warning)]">
          <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{t('patternUnavailable')}</span>
        </p>
      ) : null}

      {field.help && field.type !== 'boolean' ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
          {field.help}
        </p>
      ) : null}
      {errorText ? (
        <p
          role="alert"
          className="font-mono-num mt-1 text-[11px] text-[color:var(--oxblood)]"
        >
          {errorText}
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
