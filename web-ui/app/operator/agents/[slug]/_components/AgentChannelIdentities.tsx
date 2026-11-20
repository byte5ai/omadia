'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import {
  getAgentChannelIdentities,
  localizedText,
  parseChannelIdentityErrorCode,
  removeAgentChannelIdentity,
  setAgentChannelIdentity,
  type ChannelIdentityChannelDto,
} from '../../../../_lib/agentChannelIdentities';
import { humanizeApiError } from '../../_components/AgentsDashboard';

interface AgentChannelIdentitiesProps {
  readonly slug: string;
}

/**
 * Spec 2042 §5.3 — the agent's own bot on Telegram, Discord, Slack.
 *
 * One card per channel whose plugin can run a bot per agent. Without a bot
 * of its own, the agent is reached through the channel's shared bot (`/agent`
 * and a name line); with one, everyone writing to that bot talks to this
 * agent, and the agent posts through it. The fields come from the channel
 * plugin; secrets are write-only — the server never returns them, so the form
 * is empty again after saving.
 */
export function AgentChannelIdentities(props: AgentChannelIdentitiesProps): React.ReactElement | null {
  const t = useTranslations('operatorAgents.channelIdentities');
  const [channels, setChannels] = useState<readonly ChannelIdentityChannelDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseChannelIdentityErrorCode(err);
      return code !== null ? t(`errors.${code}`) : t('errors.unknown', { detail: humanizeApiError(err) });
    },
    [t],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await getAgentChannelIdentities(props.slug);
      setChannels(res.channels);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <h2 className="mb-1 text-lg font-medium">{t('heading')}</h2>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>
      {error !== null ? (
        <p role="alert" className="mb-2 text-xs text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
      {channels === null && error === null ? (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('loading')}</p>
      ) : null}
      {channels !== null && channels.length === 0 ? (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('noChannels')}</p>
      ) : null}
      <div className="flex flex-col gap-3">
        {(channels ?? []).map((channel) => (
          <ChannelCard
            key={channel.channelType}
            slug={props.slug}
            channel={channel}
            onChanged={refresh}
            localizeError={localizeError}
          />
        ))}
      </div>
    </section>
  );
}

interface ChannelCardProps {
  readonly slug: string;
  readonly channel: ChannelIdentityChannelDto;
  readonly onChanged: () => Promise<void>;
  readonly localizeError: (err: unknown) => string;
}

function ChannelCard(props: ChannelCardProps): React.ReactElement {
  const t = useTranslations('operatorAgents.channelIdentities');
  const locale = useLocale();
  const format = useFormatter();
  const { channel } = props;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const channelName = t.has(`channelNames.${channel.channelType}`)
    ? t(`channelNames.${channel.channelType}`)
    : channel.channelType;
  const identity = channel.identity;
  const pluginInactive = channel.fields.length === 0;
  const complete = channel.fields.every((f) => f.required === false || (values[f.key] ?? '').trim() !== '');

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await setAgentChannelIdentity(props.slug, channel.channelType, values);
      setValues({});
      setError(null);
      await props.onChanged();
    } catch (err: unknown) {
      setError(props.localizeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setConfirmRemove(false);
    setBusy(true);
    try {
      await removeAgentChannelIdentity(props.slug, channel.channelType);
      setError(null);
      await props.onChanged();
    } catch (err: unknown) {
      setError(props.localizeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-[color:var(--border)] p-3" data-testid={`channel-identity-${channel.channelType}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{channelName}</h3>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {identity === null ? t('sharedBot') : t(`state.${identity.status.state}`)}
        </span>
      </div>
      {identity !== null ? (
        <div className="flex flex-col gap-2 text-xs">
          <p>
            {t('ownBot', {
              name: identity.externalRef ?? identity.displayName ?? identity.channelKey,
              since: format.dateTime(new Date(identity.createdAt), { dateStyle: 'medium' }),
            })}
          </p>
          <p className="font-mono text-[10px] text-[color:var(--fg-muted)]">{t('routingKey', { key: identity.channelKey })}</p>
          {pluginInactive ? <p className="text-[color:var(--fg-muted)]">{t('pluginInactive')}</p> : null}
          <div>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
              {t('remove')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-xs text-[color:var(--fg-muted)]">{t('sharedBotHint')}</p>
          {channel.fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-xs">
              <span>{localizedText(field.label, locale)}</span>
              <input
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                className="rounded border border-[color:var(--border)] bg-transparent px-2 py-1 font-mono"
                value={values[field.key] ?? ''}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
              {field.help ? (
                <span className="text-[11px] text-[color:var(--fg-muted)]">{localizedText(field.help, locale)}</span>
              ) : null}
            </label>
          ))}
          <div>
            <Button type="submit" size="sm" disabled={busy || !complete}>
              {busy ? t('saving') : t('save')}
            </Button>
          </div>
        </form>
      )}
      {error !== null ? (
        <p role="alert" className="mt-2 text-xs text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        title={t('removeConfirmTitle', { channel: channelName })}
        body={t('removeConfirmBody')}
        confirmLabel={t('remove')}
        cancelLabel={t('cancel')}
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
