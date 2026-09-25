'use client';

/**
 * The login-code input for the in-app subscription sign-in (#1084).
 *
 * Presentational only: the panel owns the code state, the session and the
 * submit. Used twice — as the main field when the CLI printed a paste prompt,
 * and as the secondary fallback under the browser-callback wait, so a login
 * the middleware classified as callback-only can still be finished by pasting
 * the code the browser shows.
 */
import type { useTranslations } from 'next-intl';

import { Button, type ButtonVariant } from '../../../_components/ui/Button';

interface LoginCodeFormProps {
  readonly code: string;
  readonly onCodeChange: (code: string) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
  /** Rendered next to the submit button when given. */
  readonly onCancel?: () => void;
  /** `primary` for the main field, `secondary` for the fallback. */
  readonly submitVariant?: ButtonVariant;
  readonly t: ReturnType<typeof useTranslations>;
}

export function LoginCodeForm({
  code,
  onCodeChange,
  onSubmit,
  busy,
  onCancel,
  submitVariant = 'primary',
  t,
}: LoginCodeFormProps): React.ReactElement {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={code}
        onChange={(e) => onCodeChange(e.target.value)}
        placeholder={t('connect.codePlaceholder')}
        className="min-w-[260px] flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-1.5 text-sm text-[color:var(--fg-strong)]"
      />
      <Button
        variant={submitVariant}
        size="sm"
        busy={busy}
        busyLabel={t('connect.submitting')}
        onClick={onSubmit}
      >
        {t('connect.submit')}
      </Button>
      {onCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('connect.cancel')}
        </Button>
      ) : null}
    </div>
  );
}
