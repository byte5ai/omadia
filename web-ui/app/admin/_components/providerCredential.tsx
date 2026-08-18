'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { ErrorHelp } from '@/app/_components/ErrorHelp';
import { ApiError, type ProviderCredentialStatus } from '@/app/_lib/api';

/**
 * Shared building blocks for every provider-admin surface (LLM `providers/`,
 * transcription — and whatever capability comes next): the 4-state credential
 * chip, the save-status chip, the save-error disclosure, and the stable
 * provider comparator. All user-facing copy resolves against the
 * `adminProviders` namespace — the verdicts these render come from the ONE
 * shared `providerCredentialVerifier`, so their wording is shared too.
 */

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** The machine code behind a failed call, or `null` when there is none.
 *
 * OM-09: this used to be `friendlyError`, which parsed the same body, threw
 * the code away and returned the backend's English `message` for the panel to
 * render as its headline. `ApiError` now parses the code once, and the
 * headline comes from the localized catalogue instead; the server's own text
 * survives only inside the support disclosure of `<ErrorHelp>`. */
export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

/**
 * Stable provider ordering, mirroring the server's comparator (OM-10b): keyed
 * providers first, then by label, then by id. The server already sorts, but
 * saving a key re-activates the plugin and re-registers its models, which used
 * to bounce the provider the operator just configured to the bottom of the
 * list — so the presentation order is pinned client-side too and never depends
 * on the order the response happened to arrive in.
 *
 * Deliberately NOT `localeCompare`: server and client can resolve different
 * collations, and a mismatch would break hydration (see `_components/Nav.tsx`).
 */
export function compareProviders(
  a: { connected: boolean; label: string; id: string },
  b: { connected: boolean; label: string; id: string },
): number {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * One failed key save. A pre-flattened per-field message stays as-is; a thrown
 * `ApiError` goes through the catalogue, so its code never reaches the screen
 * as text.
 */
export function SaveError({ error }: { error: unknown }): React.ReactElement | null {
  if (error === undefined || error === null) return null;
  if (typeof error === 'string') {
    return <p className="text-[12px] text-[color:var(--danger)]">{error}</p>;
  }
  return <ErrorHelp code={errorCode(error)} rawDetail={error} />;
}

/** Chip colours per Lume: text + edge only, never a filled state block. */
const CHIP_CLASS: Record<ProviderCredentialStatus, string> = {
  verified: 'border-[color:var(--success)]/40 text-[color:var(--success)]',
  unverified: 'border-[color:var(--warning)]/40 text-[color:var(--warning)]',
  invalid: 'border-[color:var(--danger)]/40 text-[color:var(--danger)]',
  no_key: 'border-[color:var(--border)] text-[color:var(--fg-muted)]',
};

const CHIP_LABEL_KEY: Record<ProviderCredentialStatus, string> = {
  verified: 'providers.verified',
  invalid: 'providers.invalid',
  unverified: 'providers.unverified',
  no_key: 'providers.notConnected',
};

/** #671 — `ProviderVerificationReason` codes → localized copy. Deliberately a
 *  closed map rather than a template lookup: an unknown code from a newer
 *  middleware renders nothing, instead of printing the raw code at the
 *  operator. Mirrors `ProviderVerificationReason` in
 *  `middleware/src/platform/providerCredentialVerifier.ts`. */
const UNVERIFIED_REASON_KEYS: Record<string, string | undefined> = {
  forbidden: 'providers.unverifiedReason.forbidden',
  non_json_response: 'providers.unverifiedReason.nonJsonResponse',
  unexpected_body: 'providers.unverifiedReason.unexpectedBody',
  http_error: 'providers.unverifiedReason.httpError',
  network_error: 'providers.unverifiedReason.networkError',
  no_probe: 'providers.unverifiedReason.noProbe',
};

/**
 * Four-state credential chip. The old two-state version showed "CONNECTED" for
 * any non-empty vault string, which is what let a dead key look healthy — so
 * "a key exists" and "the key works" are visibly different states
 * (the OM-02/03/04 lesson).
 */
export function ConnectionChip({
  provider: p,
}: {
  provider: {
    status: ProviderCredentialStatus;
    verifiedAt?: string;
    verifyReason?: string;
  };
}): React.ReactElement {
  const t = useTranslations('adminProviders');
  const format = useFormatter();
  return (
    <span className="flex items-center gap-2">
      <span
        className={[
          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
          CHIP_CLASS[p.status],
        ].join(' ')}
      >
        {t(CHIP_LABEL_KEY[p.status])}
      </span>
      {p.status === 'verified' && p.verifiedAt && (
        <span className="text-[11px] text-[color:var(--fg-muted)]">
          {t('providers.verifiedAt', {
            time: format.relativeTime(new Date(p.verifiedAt)),
          })}
        </span>
      )}
      {/* #671 — `unverified` on its own is not actionable: it covers "your key
          is fine but your region is blocked" and "the provider was down" with
          the same chip. #599 was right to stop calling a bare 403 a bad key;
          this says which of those it actually was. Unknown codes render
          nothing rather than a raw string — a newer middleware must never leak
          an untranslated code into the UI. */}
      {p.status === 'unverified' &&
        p.verifyReason &&
        UNVERIFIED_REASON_KEYS[p.verifyReason] && (
          <span className="text-[11px] text-[color:var(--fg-muted)]">
            {t(UNVERIFIED_REASON_KEYS[p.verifyReason]!)}
          </span>
        )}
    </span>
  );
}

export function StatusChip({
  status,
}: {
  status: SaveStatus;
}): React.ReactElement | null {
  const t = useTranslations('adminProviders');
  if (status === 'idle') return null;
  const map: Record<Exclude<SaveStatus, 'idle'>, { key: string; cls: string }> = {
    saving: { key: 'saving', cls: 'text-[color:var(--fg-muted)]' },
    saved: { key: 'saved', cls: 'text-[color:var(--success)]' },
    error: { key: 'errorChip', cls: 'text-[color:var(--danger)]' },
  };
  const { key, cls } = map[status];
  return <span className={`text-[11px] ${cls}`}>{t(`status.${key}`)}</span>;
}
