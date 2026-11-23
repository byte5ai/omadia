'use client';

import { useTranslations } from 'next-intl';

import type { MessageSpeaker } from '../../_lib/chatSessions';

interface Props {
  speaker: MessageSpeaker;
}

/** First letter of a name, for the avatar placeholder. */
function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

/**
 * #2045 — who an assistant message is from (spec 2042 INV-4): the agent's
 * avatar and name, stamped by the harness, never by the model; or the
 * management layer's `system` label for a notice. Shown on every message so
 * a conversation never leaves the speaker unclear.
 */
export function MessageSpeakerLine({ speaker }: Props): React.ReactElement {
  const t = useTranslations('chat.speaker');
  if (speaker.kind === 'system') {
    return (
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
        <span aria-hidden="true">ⓘ</span>
        <span>{t('system')}</span>
      </div>
    );
  }
  return (
    <div className="mb-1 flex items-center gap-2 text-xs font-medium text-[color:var(--fg-muted)]">
      {speaker.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin avatar, sized by CSS
        <img
          src={speaker.avatarUrl}
          alt={t('avatarAlt', { name: speaker.displayName })}
          className="h-5 w-5 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--bg-inverse)] text-[10px] text-[color:var(--fg-on-dark)]"
        >
          {initial(speaker.displayName)}
        </span>
      )}
      <span>{speaker.displayName}</span>
    </div>
  );
}
