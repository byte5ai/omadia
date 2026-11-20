'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '../../../_lib/api';
import {
  deleteDefaultAgentEntry,
  listDefaultAgentEntries,
  putDefaultAgentEntry,
  type DefaultAgentEntryDto,
  type OperatorAgentDto,
} from '../../../_lib/agents';

/**
 * #2055 / #2057 — the default-agent table: who reaches which agent when they
 * address none. One row per (user, channel type), (user), (channel type) and
 * the instance; the most specific row wins. A row names an agent that is
 * available where the row applies, or `off` (the sender gets a system notice).
 * The instance row is set, never removed.
 */

const NO_AGENT = '';
const ANY_CHANNEL = '';

/** The refusals the server names with a 409; each has its own sentence. */
const REFUSAL_CODES = [
  'agent_deleted',
  'agent_disabled',
  'archetype_not_default',
  'agent_not_available_in_every_channel',
  'agent_not_available_in_channel',
  'agent_not_available_to_everyone',
  'agent_not_available_to_user',
] as const;
type RefusalCode = (typeof REFUSAL_CODES)[number];

function refusalCodeOf(err: unknown): RefusalCode | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return REFUSAL_CODES.find((c) => c === err.code);
}

/** `anna@example.com` and `user:anna@example.com` both name the user `anna@example.com`. */
export function toUserPrincipal(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return /^user:/i.test(trimmed) ? `user:${trimmed.slice('user:'.length)}` : `user:${trimmed}`;
}

/** Most specific first, so the table reads in the order routing applies it. */
function specificity(e: DefaultAgentEntryDto): number {
  return (e.principal !== null ? 2 : 0) + (e.channel_type !== null ? 1 : 0);
}

export interface DefaultAgentsSectionProps {
  /** Agents an entry may name (enabled standard agents). */
  agents: readonly OperatorAgentDto[];
  /** Channel types known on this instance. */
  channelTypes: readonly string[];
  disabled?: boolean;
}

export function DefaultAgentsSection(props: DefaultAgentsSectionProps): React.ReactElement {
  const t = useTranslations('operatorAgents.defaultEntries');
  const [entries, setEntries] = useState<DefaultAgentEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState('');
  const [channel, setChannel] = useState(ANY_CHANNEL);
  const [agent, setAgent] = useState(NO_AGENT);

  const reload = useCallback(async () => {
    try {
      setEntries(await listDefaultAgentEntries());
      setError(null);
    } catch {
      setError(t('loadError'));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const write = async (op: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await op();
      await reload();
    } catch (err: unknown) {
      const code = refusalCodeOf(err);
      setError(code ? t(`refusal.${code}`) : t('writeError'));
    } finally {
      setBusy(false);
    }
  };

  const locked = busy || props.disabled === true;
  const sorted = [...(entries ?? [])].sort((a, b) => specificity(b) - specificity(a));

  return (
    <section
      data-testid="default-agents-section"
      className="space-y-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4"
    >
      <h2 className="text-lg font-medium">{t('heading')}</h2>
      <p className="text-sm text-[color:var(--fg-muted)]">{t('help')}</p>
      {error && (
        <p role="alert" className="text-sm text-[color:var(--danger)]">
          {error}
        </p>
      )}
      {entries === null ? (
        !error && <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[color:var(--fg-muted)]">
              <th className="py-1 pr-3 font-normal">{t('colWho')}</th>
              <th className="py-1 pr-3 font-normal">{t('colChannel')}</th>
              <th className="py-1 pr-3 font-normal">{t('colAgent')}</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              const isInstance = e.principal === null && e.channel_type === null;
              return (
                <tr key={e.id} data-testid={`default-entry-${e.id}`} className="border-t border-[color:var(--border)]">
                  <td className="py-1 pr-3">{e.principal?.replace(/^user:/, '') ?? t('everyone')}</td>
                  <td className="py-1 pr-3">{e.channel_type ?? t('everyChannel')}</td>
                  <td className="py-1 pr-3">
                    {e.off ? (
                      <span className="text-[color:var(--fg-muted)]">{t('off')}</span>
                    ) : (
                      <>
                        {e.agent_name ?? e.agent_slug}
                        {e.agent_status !== null && e.agent_status !== 'enabled' && (
                          <span className="ml-2 text-xs text-[color:var(--warning)]">
                            {t('statusBadge', { status: e.agent_status === 'deleted' ? 'deleted' : 'disabled' })}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="py-1 text-right">
                    {isInstance ? (
                      <span className="text-xs text-[color:var(--fg-muted)]">{t('instanceRow')}</span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={locked}
                        aria-label={t('removeRow', {
                          who: e.principal?.replace(/^user:/, '') ?? t('everyone'),
                          channel: e.channel_type ?? t('everyChannel'),
                        })}
                        onClick={() => void write(() => deleteDefaultAgentEntry(e.id))}
                      >
                        {t('remove')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form
        className="flex flex-wrap items-end gap-3 border-t border-[color:var(--border)] pt-3 text-sm"
        onSubmit={(ev) => {
          ev.preventDefault();
          void write(() =>
            putDefaultAgentEntry({
              principal: toUserPrincipal(who),
              channelType: channel === ANY_CHANNEL ? null : channel,
              agentSlug: agent === NO_AGENT ? null : agent,
            }),
          );
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[color:var(--fg-muted)]">{t('fieldWho')}</span>
          <input
            className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1"
            value={who}
            placeholder={t('everyone')}
            onChange={(e) => setWho(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[color:var(--fg-muted)]">{t('fieldChannel')}</span>
          <select
            className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value={ANY_CHANNEL}>{t('everyChannel')}</option>
            {props.channelTypes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[color:var(--fg-muted)]">{t('fieldAgent')}</span>
          <select
            className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value={NO_AGENT}>{t('off')}</option>
            {props.agents
              .filter((a) => a.status === 'enabled')
              .map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={locked}>
          {t('save')}
        </Button>
      </form>
    </section>
  );
}
