'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  getAgentPeerChannels,
  parseOperatorAgentErrorCode,
  removeAgentPeerChannel,
  setAgentAgentToAgent,
  setAgentPeerChannel,
  type AgentToAgentMode,
  type PeerChannelDto,
} from '../../../../_lib/agents';
import { humanizeApiError } from '../../_components/AgentsDashboard';

interface AgentPeersProps {
  readonly slug: string;
}

/**
 * #1018 — the two switches for agent-to-agent conversation.
 *
 * Agent-to-agent talk is an orchestrator-internal relay: every participant
 * posts under its own bot, the kernel rotates the floor and bounds the
 * length. What this section controls is WHETHER this agent may take part,
 * and WHERE — the agent's own switch AND one row per chat, combined with
 * AND. Both default to off; a flip here stops a running discussion at the
 * agent's next turn.
 *
 * A chat is addressed by the channel's own conversation key (for Teams the
 * `19:…@thread.skype` id of a group chat). The operator adds a row per chat;
 * the relay only ever considers bots that are actually present there, so a
 * row for a chat the bot was never added to is harmless.
 */
export function AgentPeers(props: AgentPeersProps): React.ReactElement {
  const t = useTranslations('operatorAgents.peers');
  const tErr = useTranslations('operatorAgents');
  const [mode, setMode] = useState<AgentToAgentMode | null>(null);
  const [channels, setChannels] = useState<PeerChannelDto[]>([]);
  const [newType, setNewType] = useState('teams');
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseOperatorAgentErrorCode(err);
      return code !== null
        ? tErr(`detailErrors.${code}`)
        : tErr('detailErrors.unknown', { detail: humanizeApiError(err) });
    },
    [tErr],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await getAgentPeerChannels(props.slug);
      setMode(res.mode);
      setChannels(res.channels);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    } finally {
      setLoading(false);
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      try {
        await fn();
        await refresh();
      } catch (err: unknown) {
        setError(localizeError(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh, localizeError],
  );

  const toggleMode = (next: AgentToAgentMode): void => {
    void run(() => setAgentAgentToAgent(props.slug, next));
  };

  const addChannel = (): void => {
    const key = newKey.trim();
    const type = newType.trim();
    if (!key || !type) return;
    void run(async () => {
      await setAgentPeerChannel(props.slug, type, key, true);
      setNewKey('');
    });
  };

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t('heading')}</h2>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {mode === null
            ? t('stateUnknown')
            : t('stateSummary', {
                mode: t(`modes.${mode}`),
                chats: channels.filter((c) => c.enabled).length,
              })}
        </span>
      </div>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      {loading && mode === null && !error && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}

      {mode !== null && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('heading')}</legend>
            {(['off', 'on'] as const).map((m) => (
              <label
                key={m}
                className="flex cursor-pointer items-start gap-2 rounded border border-[color:var(--border)]/60 p-2 text-sm"
              >
                <input
                  type="radio"
                  className="mt-1"
                  name={`agent-to-agent-${props.slug}`}
                  value={m}
                  checked={mode === m}
                  disabled={busy}
                  onChange={() => toggleMode(m)}
                />
                <span>
                  <span className="font-medium text-[color:var(--fg-strong)]">{t(`modes.${m}`)}</span>
                  <span className="block text-xs text-[color:var(--fg-muted)]">{t(`modeHints.${m}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="mt-4">
            <h3 className="text-sm font-medium text-[color:var(--fg-strong)]">{t('chatsHeading')}</h3>
            <p className="mb-2 text-xs text-[color:var(--fg-muted)]">{t('chatsHint')}</p>
            {channels.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('chatsEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {channels.map((c) => (
                  <li
                    key={`${c.channelType}|${c.channelKey}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-[color:var(--border)]/60 px-2 py-1 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <code className="text-xs text-[color:var(--fg-muted)]">{c.channelType}</code>
                      <code className="break-all text-xs">{c.channelKey}</code>
                    </span>
                    <span className="flex items-center gap-2">
                      <label className="flex cursor-pointer items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={c.enabled}
                          disabled={busy}
                          onChange={(e) =>
                            void run(() =>
                              setAgentPeerChannel(props.slug, c.channelType, c.channelKey, e.target.checked),
                            )
                          }
                        />
                        {c.enabled ? t('chatEnabled') : t('chatDisabled')}
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void run(() => removeAgentPeerChannel(props.slug, c.channelType, c.channelKey))}
                      >
                        {t('remove')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-xs">
                <span className="mb-1 text-[color:var(--fg-muted)]">{t('channelTypeLabel')}</span>
                <input
                  className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
                  value={newType}
                  disabled={busy}
                  onChange={(e) => setNewType(e.target.value)}
                />
              </label>
              <label className="flex flex-1 flex-col text-xs">
                <span className="mb-1 text-[color:var(--fg-muted)]">{t('channelKeyLabel')}</span>
                <input
                  className="min-w-64 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
                  value={newKey}
                  placeholder={t('channelKeyPlaceholder')}
                  disabled={busy}
                  onChange={(e) => setNewKey(e.target.value)}
                />
              </label>
              <Button size="sm" busy={busy} busyLabel={t('adding')} disabled={!newKey.trim() || busy} onClick={addChannel}>
                {t('add')}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
