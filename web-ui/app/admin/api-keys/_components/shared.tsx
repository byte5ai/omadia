'use client';

import { useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import { ApiError } from '@/app/_lib/api';

/** Shared styling + error-formatting for the API-keys admin panel — mirrors
 *  the same tiny per-feature `shared.tsx` pattern already used by
 *  `admin/webhooks/_components/shared.tsx` rather than reaching for a
 *  cross-feature util module. */

export const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

/** Scope / data chip — Geist Mono register per the Lume type-scale (§2.7,
 *  `.type-mono-data`), since a scope string is data, not UI chrome. */
export const chipCls =
  'type-mono-data inline-flex items-center rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[11px] lowercase text-[color:var(--fg-muted)]';

/**
 * Block-level error text — text + a 1px edge + a light tint, never
 * text-only and never a solid fill (Lume state-color rule, spec §2.6). Same
 * recipe used repo-wide for inline error banners, e.g.
 * `admin/domains/page.tsx`'s `loadError` paragraph.
 */
export const errorTextCls =
  'rounded-md border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-[13px] text-[color:var(--danger)]';

/** Compact inline variant of `errorTextCls` for a short note sitting next to
 *  buttons rather than a full-width paragraph (e.g. a copy-to-clipboard
 *  fallback notice) — same border+tint recipe, smaller footprint. */
export const errorInlineCls =
  'inline-flex items-center gap-1 rounded-md border border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/8 px-2 py-0.5 text-[12px] text-[color:var(--danger)]';

type TFn = (key: string, values?: Record<string, string | number>) => string;

/**
 * web-ui/CLAUDE.md hard rule #3: never render a raw ApiError/exception
 * message as the primary UI text. Maps the backend's known `{error|code}`
 * response shapes (see `adminKeysRouter.ts`) to translated catalog messages
 * and falls back to a generic "request failed (status N)" message — never
 * the raw response body, which for a 400 can be a zod `issues` array dumped
 * as JSON. Mirrors `admin/registries/page.tsx`'s `toFriendlyError`.
 */
export function toFriendlyError(err: unknown, t: TFn): string {
  if (err instanceof ApiError) {
    if (err.body.includes('not_found')) return t('errors.notFound');
    if (err.body.includes('operator_auth.unavailable')) return t('errors.authUnavailable');
    if (err.body.includes('auth.missing') || err.body.includes('auth.invalid')) {
      return t('errors.sessionExpired');
    }
    if (err.body.includes('invalid_request')) return t('errors.invalidRequest');
    return t('errors.generic', { status: err.status });
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Active/revoked status — text + a 1px edge + at most a light tint, never a
 * solid-filled pill (Lume state-color rule, spec §2.6). Same recipe as
 * `admin/webhooks/_components/shared.tsx`'s `StatusBadge`.
 */
export function KeyStatusBadge({ revokedAt }: { revokedAt?: number }): React.ReactElement {
  const t = useTranslations('adminApiKeys.list.status');
  const revoked = revokedAt !== undefined;
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
        revoked
          ? 'border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/8 text-[color:var(--danger)]'
          : 'border-[color:var(--success)]/50 bg-[color:var(--success)]/8 text-[color:var(--success)]',
      ].join(' ')}
    >
      {revoked ? t('revoked') : t('active')}
    </span>
  );
}

/**
 * The reason #567 exists: a public MCP key-binding (#550) references a key by
 * its `ApiKeyRecord.id`, so the operator needs to copy that id out of this
 * list rather than reading it out of the API by hand. The id is shown
 * verbatim (in the mono data register) with a one-click copy; a failed
 * clipboard write leaves the id visible and selectable for manual copy.
 */
export function CopyIdButton({ id }: { id: string }): React.ReactElement {
  const t = useTranslations('adminApiKeys.list');
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      // Soft failure (permissions, insecure context) — the id stays visible
      // and selectable next to this button, so the operator can copy it by
      // hand. Not worth an error banner.
      setCopied(false);
    }
  }, [id]);

  return (
    // eslint-disable-next-line no-restricted-syntax -- bespoke inline data chip: the control's own label IS the key id in the mono-data register plus a micro caption, no §4.2 variant
    <button
      type="button"
      onClick={() => void onCopy()}
      title={t('copyIdTitle')}
      className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)] transition-colors hover:border-[color:var(--accent)] hover:text-[color:var(--fg)]"
    >
      <span className="type-mono-data lowercase">{id}</span>
      <span className="uppercase tracking-[0.12em]">
        {copied ? t('copyIdCopied') : t('copyId')}
      </span>
    </button>
  );
}
