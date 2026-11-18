'use client';

import { ShieldAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { cn } from '../../_lib/cn';
import { enumOptionLabel, pickLocalized } from '../../_lib/localized';
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
  /** #1401 — interpolation values for the localized text (e.g. `host`). */
  params?: Record<string, string>;
  message: string;
}

type ErrorTranslator = (key: string, values?: Record<string, string>) => string;

/** Field types whose `wrong_type` message has its own catalog entry. */
const WRONG_TYPE_KEYS: Readonly<Record<string, string>> = {
  string: 'wrongTypeText',
  secret: 'wrongTypeText',
  enum: 'wrongTypeText',
  url: 'wrongTypeUrl',
  boolean: 'wrongTypeBoolean',
  integer: 'wrongTypeInteger',
  host_list: 'wrongTypeHostList',
};

/** Codes whose text needs only the field label. */
const LABEL_ONLY_KEYS: Readonly<Record<string, string>> = {
  required: 'required',
  invalid_url: 'invalidUrl',
  not_submittable: 'notSubmittable',
};

/** `json_file` upload failures that need no field-specific detail. */
const UPLOAD_KEYS: Readonly<Record<string, string>> = {
  too_large: 'uploadTooLarge',
  not_json: 'uploadNotJson',
  not_an_object: 'uploadNotAnObject',
};

/**
 * Codes whose text interpolates server `params` (`setupJsonFile.ts`). Listed
 * as [catalog key, params required]; the first entry whose params are all
 * present wins, so `unexpected_document` picks the "has value X" sentence
 * when the server sent `actual`, and the "is missing" one otherwise.
 */
export const PARAM_KEYS: Readonly<
  Record<string, ReadonlyArray<readonly [string, readonly string[]]>>
> = {
  invalid_host: [['invalidHost', ['host']]],
  unexpected_document: [
    ['uploadUnexpectedValue', ['key', 'actual', 'expected']],
    ['uploadUnexpectedMissing', ['key', 'expected']],
  ],
  missing_value: [['uploadMissingValue', ['path', 'target']]],
  bad_extract_path: [['uploadBadExtractPath', ['path', 'target']]],
};

function paramText(
  error: SetupFieldError,
  t: ErrorTranslator,
): string | undefined {
  for (const [key, needed] of PARAM_KEYS[error.code ?? ''] ?? []) {
    const values: Record<string, string> = {};
    let complete = true;
    for (const name of needed) {
      const v = error.params?.[name];
      if (typeof v !== 'string') {
        complete = false;
        break;
      }
      values[name] = v;
    }
    if (complete) return t(key, values);
  }
  return undefined;
}

/**
 * #1401 — the text for one server validation error, in the active locale.
 * Unknown codes, and codes whose parameters the response lacks, keep the
 * server's own `message`.
 */
export function localizedFieldError(
  error: SetupFieldError,
  field: InstallSetupField,
  label: string,
  patternHint: string | undefined,
  t: ErrorTranslator,
): string {
  const code = error.code;
  if (code === undefined) return error.message;
  if (code === 'pattern_mismatch') return patternHint ?? t('patternMismatch', { label });
  const labelOnly = LABEL_ONLY_KEYS[code];
  if (labelOnly) return t(labelOnly, { label });
  if (code === 'wrong_type') {
    const key = WRONG_TYPE_KEYS[field.type];
    return key ? t(key, { label }) : error.message;
  }
  if (code === 'enum_mismatch') {
    const allowed = (field.enum ?? []).map((o) => o.value).join(', ');
    return allowed ? t('enumMismatch', { label, allowed }) : error.message;
  }
  if (PARAM_KEYS[code]) return paramText(error, t) ?? error.message;
  const upload = UPLOAD_KEYS[code];
  return upload ? t(upload) : error.message;
}

export function FieldRow({
  field,
  error,
  idPrefix = 'install-field',
  coveredByUpload = false,
}: {
  field: InstallSetupField;
  error?: SetupFieldError;
  idPrefix?: string;
  /**
   * #603 (OM-17) — true when a `json_file` field in the same form declares
   * this field as an `extracts` target. The browser's NATIVE `required` check
   * then must not fire: it would refuse the submit silently (a native tooltip
   * the app cannot localize) while the operator has attached the file that
   * supplies the value. Requiredness is still enforced — by the server, AFTER
   * it merged the extracted values — so nothing is lost, only the false stop.
   */
  coveredByUpload?: boolean;
}): React.ReactElement {
  const t = useTranslations('store.setupForm');
  const locale = useLocale();
  const id = `${idPrefix}-${field.key}`;
  const nativeRequired = field.required && !coveredByUpload;
  const patternHint = pickLocalized(field.pattern_hint, locale);
  // #602 (OM-17) — label/help are localized maps; resolve them at the active
  // locale. A missing label falls back to the field key (never blank).
  const fieldLabel = pickLocalized(field.label, locale) ?? field.key;
  const fieldHelp = pickLocalized(field.help, locale);
  // OM-17 / #1401 — the server writes its validation messages in ONE
  // language (it has no request locale), so the text is rendered here from
  // the catalog by `code`, in the operator's locale. The server's `message`
  // is the fallback for a code this build does not know.
  const tErr = useTranslations('store.setupForm.errors');
  const errorText =
    error === undefined
      ? undefined
      : localizedFieldError(error, field, fieldLabel, patternHint, tErr);
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
          {fieldLabel}
          {field.required ? (
            <span className="ml-1 text-[color:var(--oxblood)]">*</span>
          ) : null}
        </span>
        <span className="font-mono-num normal-case tracking-normal text-[color:var(--faint-ink)]">
          {field.type}
        </span>
      </label>

      <div className="mt-2">
        {/*
          #603 (OM-17) — a `json_file` field is a FILE PICKER, never a text box.
          Falling through to the text input below would be worse than not having
          the type at all: it would ask the operator to paste a raw
          service-account key into a field, which is the transcription step this
          feature exists to remove. The upload is posted to
          `…/secrets/from-json`, parsed server-side, and only the derived keys
          are stored — so this input has no `name` and submits nothing itself.
        */}
        {field.type === 'json_file' ? (
          <input
            id={id}
            type="file"
            accept={field.accept ?? 'application/json'}
            data-json-file-field={field.key}
            className="block w-full border border-[color:var(--rule-strong)] bg-[color:var(--paper)] px-3 py-2 text-sm file:mr-3 file:border-0 file:bg-[color:var(--rule)] file:px-3 file:py-1 file:text-sm"
          />
        ) : field.type === 'boolean' ? (
          <label
            htmlFor={id}
            className="flex items-center gap-3 border border-[color:var(--rule-strong)] bg-[color:var(--paper)] px-3 py-2 text-sm"
          >
            <input
              id={id}
              name={field.key}
              type="checkbox"
              // #1464 — `"true"` is a valid boolean default too (the install
              // API accepts it as a value). Current servers normalize it; this
              // also covers an older server that passes the raw string through.
              defaultChecked={field.default === true || field.default === 'true'}
              className="size-4 accent-[color:var(--oxblood)]"
            />
            <span className="text-[color:var(--muted-ink)]">
              {fieldHelp ?? t('enable')}
            </span>
          </label>
        ) : field.type === 'enum' ? (
          <select
            id={id}
            name={field.key}
            required={nativeRequired}
            defaultValue={typeof field.default === 'string' ? field.default : ''}
            className={common}
          >
            {!field.required ? (
              <option value="">{t('dontSet')}</option>
            ) : null}
            {(field.enum ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {enumOptionLabel(opt, locale)}
              </option>
            ))}
          </select>
        ) : field.type === 'integer' ? (
          <input
            id={id}
            name={field.key}
            type="number"
            step={1}
            required={nativeRequired}
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
            required={nativeRequired}
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
            required={nativeRequired}
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

      {fieldHelp && field.type !== 'boolean' ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
          {fieldHelp}
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
    // #603 (OM-17) — a `json_file` field submits NOTHING under its own key. The
    // file goes to `…/secrets/from-json`, where the server parses it and stores
    // only the derived keys; the middleware's `coerce()` refuses a value here
    // for the same reason. Skipping it in one place and not the other would send
    // the raw document to an endpoint that rejects it, and the operator would
    // see a validation error for a field they never typed in.
    if (field.type === 'json_file') continue;
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


/**
 * #603 (OM-17) — keys supplied by at least one `json_file` field's `extracts`
 * in this form. Used to drop the native `required` attribute on those inputs.
 */
export function uploadCoveredKeys(fields: InstallSetupField[]): Set<string> {
  const covered = new Set<string>();
  for (const f of fields) {
    if (f.type !== 'json_file' || !f.extracts) continue;
    for (const target of Object.keys(f.extracts)) covered.add(target);
  }
  return covered;
}
