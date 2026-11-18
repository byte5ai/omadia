'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

type CopyState = 'idle' | 'copied' | 'failed';

interface OneTimeSecretProps {
  /** The value the server returns exactly once (a signing secret, a token). */
  secret: string;
  /** The caller's own sentence saying what this secret is. */
  heading: string;
  onDismiss: () => void;
}

/**
 * #1339 — a secret the server shows exactly once, with a copy button.
 *
 * The webhook page told the operator to "copy it now" and offered only
 * "Dismiss", so the 64-character secret had to be selected by hand, and one
 * slip of the dismiss button forced a rotation. Same behaviour as the token
 * reveal on `/admin/api-keys`: Copy writes to the clipboard and confirms; when
 * the clipboard is unavailable (permissions, insecure context) the value stays
 * visible and selectable and a hint says to copy it by hand. Dismiss reads "I've
 * copied it" so it is not mistaken for a harmless close.
 */
export function OneTimeSecret({
  secret,
  heading,
  onDismiss,
}: OneTimeSecretProps): React.ReactElement {
  const t = useTranslations('oneTimeSecret');
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div
      className="mt-3 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/5 p-3"
      role="alert"
    >
      <p className="mb-1 text-[12px] font-semibold text-[color:var(--fg-strong)]">{heading}</p>
      <code className="type-mono-data block break-all rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] p-2 text-[12px] text-[color:var(--fg-strong)]">
        {secret}
      </code>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void onCopy()}>
          {copyState === 'copied' ? t('copied') : t('copy')}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          {t('dismiss')}
        </Button>
        {copyState === 'failed' && (
          <span className="text-[12px] text-[color:var(--danger)]">{t('copyFailed')}</span>
        )}
      </div>
    </div>
  );
}
