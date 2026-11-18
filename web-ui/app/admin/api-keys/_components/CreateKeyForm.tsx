'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  createApiKey,
  listApiKeyScopes,
  type ApiKeyScopeCatalog,
  type CreateApiKeyResult,
} from '@/app/_lib/api';

import { card, errorTextCls, inputCls, toFriendlyError } from './shared';

const CHAT_WRITE_SCOPE = 'chat:write';

/** Used when `GET /scopes` fails: the one scope every backend has always
 *  accepted, so the page still mints the classic chat key. */
const FALLBACK_CATALOG: ApiKeyScopeCatalog = {
  scopes: [CHAT_WRITE_SCOPE],
  mcpWritePrefix: 'mcp:write:',
};

/** Catalog key of the one-line help under each built-in scope. Plugin scopes
 *  have no built-in description and get the generic "plugin scope" line. */
const SCOPE_HELP_KEYS: Readonly<Record<string, string>> = {
  'chat:write': 'chatWrite',
  'mcp:list': 'mcpList',
  'mcp:invoke': 'mcpInvoke',
  '*': 'wildcard',
};

/** Mirrors the backend's `mcp:write:<tool>` tool segment. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

const MIN_RATE_LIMIT = 1;
const MAX_RATE_LIMIT = 6000;
const DEFAULT_RATE_LIMIT_HINT = 60;

function parseRateLimitInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function parseToolNames(raw: string): string[] {
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return [...new Set(names)];
}

/** Mirrors the backend's furthest allowed expiry (~5 years). */
const MAX_EXPIRY_YEARS = 5;

function toDateInputValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The selectable expiry range for the date input: today … +5 years. */
function expiryBounds(): { min: string; max: string } {
  const today = new Date();
  const max = new Date(today);
  max.setFullYear(today.getFullYear() + MAX_EXPIRY_YEARS);
  max.setDate(max.getDate() - 1);
  return { min: toDateInputValue(today), max: toDateInputValue(max) };
}

/** `YYYY-MM-DD` from a date input → the END of that day in the viewer's
 *  timezone, so "expires on the 31st" still works on the 31st. */
function endOfLocalDay(dateInput: string): number | undefined {
  if (!dateInput) return undefined;
  const [y, m, d] = dateInput.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

interface CreateKeyFormProps {
  /** True while a one-time token is on screen — the form stays locked so a
   *  second create cannot overwrite the first token before it is copied. */
  locked: boolean;
  onCreated: (created: CreateApiKeyResult) => Promise<void>;
}

/**
 * The create-key form. Issue #1327: the scopes come from the backend catalog
 * (`GET .../admin/keys/scopes`) instead of one hardcoded `chat:write`
 * checkbox, plus a tool list for the per-tool `mcp:write:<tool>` scope.
 * Issue #1328: optional expiry date.
 */
export function CreateKeyForm({ locked, onCreated }: CreateKeyFormProps): React.ReactElement {
  const t = useTranslations('adminApiKeys');

  const [catalog, setCatalog] = useState<ApiKeyScopeCatalog | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [label, setLabel] = useState('');
  const [rateLimitInput, setRateLimitInput] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set([CHAT_WRITE_SCOPE]));
  const [toolsInput, setToolsInput] = useState('');
  const [expiryInput, setExpiryInput] = useState('');
  // Checked against "now" when the date changes (an event, not a render), so
  // rendering stays pure.
  const [expiryInvalid, setExpiryInvalid] = useState(false);
  const [bounds] = useState(expiryBounds);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listApiKeyScopes().then(
      (c) => {
        if (!cancelled) setCatalog(c);
      },
      () => {
        if (cancelled) return;
        setCatalog(FALLBACK_CATALOG);
        setCatalogFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const rateLimitValue = useMemo(() => parseRateLimitInput(rateLimitInput), [rateLimitInput]);
  const rateLimitInvalid =
    rateLimitInput.trim() !== '' &&
    (rateLimitValue === undefined ||
      !Number.isInteger(rateLimitValue) ||
      rateLimitValue < MIN_RATE_LIMIT ||
      rateLimitValue > MAX_RATE_LIMIT);

  const toolNames = useMemo(() => parseToolNames(toolsInput), [toolsInput]);
  const toolsInvalid = toolNames.some((name) => !TOOL_NAME_PATTERN.test(name));

  const expiresAt = useMemo(() => endOfLocalDay(expiryInput), [expiryInput]);

  const prefix = (catalog ?? FALLBACK_CATALOG).mcpWritePrefix;
  const scopes = useMemo(
    () => [...selected, ...toolNames.map((name) => `${prefix}${name}`)],
    [selected, toolNames, prefix],
  );

  // A key with zero scopes authenticates and can do nothing, and the backend
  // rejects an explicit `scopes: []` outright — block it here with an
  // explanation instead of a 400 the operator has to decode.
  const canSubmit =
    scopes.length > 0 && !rateLimitInvalid && !toolsInvalid && !expiryInvalid && !creating && !locked;

  const toggleScope = useCallback((scope: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }, []);

  const onSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit) return;
    setCreateError(null);
    setCreating(true);
    try {
      const created = await createApiKey({
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(rateLimitValue !== undefined ? { rateLimitPerMinute: rateLimitValue } : {}),
        // Sent explicitly (never omitted) so the request always reflects
        // exactly what the form shows.
        scopes,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      setLabel('');
      setRateLimitInput('');
      setToolsInput('');
      setExpiryInput('');
      setExpiryInvalid(false);
      await onCreated(created);
    } catch (err) {
      setCreateError(toFriendlyError(err, t));
    } finally {
      setCreating(false);
    }
  }, [canSubmit, label, rateLimitValue, scopes, expiresAt, onCreated, t]);

  const captionCls = 'text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]';

  return (
    <section className={`${card} mb-6`}>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
        {t('create.heading')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={captionCls}>{t('create.fields.label')}</span>
          <input
            className={inputCls}
            value={label}
            maxLength={120}
            disabled={locked}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={captionCls}>{t('create.fields.rateLimit')}</span>
          <input
            className={inputCls}
            type="number"
            min={MIN_RATE_LIMIT}
            max={MAX_RATE_LIMIT}
            placeholder={String(DEFAULT_RATE_LIMIT_HINT)}
            value={rateLimitInput}
            disabled={locked}
            onChange={(e) => setRateLimitInput(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={captionCls}>{t('create.fields.expiry')}</span>
          <input
            className={inputCls}
            type="date"
            min={bounds.min}
            max={bounds.max}
            value={expiryInput}
            disabled={locked}
            onChange={(e) => {
              const value = e.target.value;
              const end = endOfLocalDay(value);
              setExpiryInput(value);
              setExpiryInvalid(value !== '' && (end === undefined || end <= Date.now()));
            }}
          />
        </label>
      </div>

      <fieldset className="mt-4 flex flex-col gap-2" disabled={locked}>
        <legend className={`mb-1 ${captionCls}`}>{t('create.fields.scopes')}</legend>
        {(catalog?.scopes ?? []).map((scope) => (
          <label key={scope} className="flex items-baseline gap-2">
            <input
              type="checkbox"
              checked={selected.has(scope)}
              onChange={(e) => toggleScope(scope, e.target.checked)}
            />
            <span className="type-mono-data text-[13px] text-[color:var(--fg)]">{scope}</span>
            <span className="text-[12px] text-[color:var(--fg-muted)]">
              {t(`create.scopeHelp.${SCOPE_HELP_KEYS[scope] ?? 'plugin'}`)}
            </span>
          </label>
        ))}
        <label className="mt-2 flex flex-col gap-1">
          <span className={captionCls}>{t('create.fields.mcpWriteTools')}</span>
          <input
            className={`${inputCls} type-mono-data`}
            value={toolsInput}
            onChange={(e) => setToolsInput(e.target.value)}
          />
          <span className="text-[12px] text-[color:var(--fg-muted)]">
            {t('create.mcpWriteToolsHint', { prefix })}
          </span>
        </label>
      </fieldset>

      <div className="mt-4">
        <Button
          variant="primary"
          onClick={() => void onSubmit()}
          disabled={!canSubmit}
          busy={creating}
          busyLabel={t('create.creating')}
        >
          {t('create.submit')}
        </Button>
      </div>

      {catalogFailed && (
        <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]">{t('create.scopesUnavailable')}</p>
      )}
      {rateLimitInvalid && (
        <p className={`mt-2 ${errorTextCls}`}>
          {t('create.rateLimitInvalid', { min: MIN_RATE_LIMIT, max: MAX_RATE_LIMIT })}
        </p>
      )}
      {toolsInvalid && <p className={`mt-2 ${errorTextCls}`}>{t('create.mcpWriteToolsInvalid')}</p>}
      {expiryInvalid && <p className={`mt-2 ${errorTextCls}`}>{t('create.expiryInvalid')}</p>}
      {scopes.length === 0 && <p className={`mt-2 ${errorTextCls}`}>{t('create.scopesRequired')}</p>}
      {locked && (
        <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]">{t('create.blockedByReveal')}</p>
      )}
      {createError && <p className={`mt-2 ${errorTextCls}`}>{createError}</p>}
    </section>
  );
}
