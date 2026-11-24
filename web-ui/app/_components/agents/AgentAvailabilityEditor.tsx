'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

import { Button } from '@/app/_components/ui/Button';
import { isPrincipal, reachesAnybody, type AgentAvailability } from '../../_lib/agentAvailability';

export interface AgentAvailabilityEditorProps {
  value: AgentAvailability;
  onChange: (next: AgentAvailability) => void;
  disabled?: boolean;
}

const inputCls =
  'w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1 text-sm';

function channelList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
    ),
  ];
}

/**
 * Spec 2042 — who may reach an agent: everyone, or the listed users and
 * roles; in every channel or only in some. A new agent reaches nobody, so the
 * Agent Builder shows this when it creates one and on every existing agent.
 * Controlled: the caller saves.
 */
export function AgentAvailabilityEditor({
  value,
  onChange,
  disabled,
}: AgentAvailabilityEditorProps): React.ReactElement {
  const t = useTranslations('agentAvailability');
  const ids = {
    everyone: useId(),
    restrict: useId(),
    channels: useId(),
    principal: useId(),
  };
  const [channelsText, setChannelsText] = useState((value.channels ?? []).join(', '));
  const [principal, setPrincipal] = useState('');
  const [principalError, setPrincipalError] = useState(false);

  const addPrincipal = (): void => {
    const next = principal.trim();
    if (!isPrincipal(next)) {
      setPrincipalError(true);
      return;
    }
    setPrincipalError(false);
    setPrincipal('');
    if (value.principals.includes(next)) return;
    onChange({ ...value, principals: [...value.principals, next] });
  };

  return (
    <fieldset
      className="space-y-2 text-sm"
      data-testid="agent-availability-editor"
      disabled={disabled}
    >
      <legend className="text-xs font-medium text-[color:var(--fg-muted)]">{t('legend')}</legend>
      <label className="flex items-center gap-2" htmlFor={ids.everyone}>
        <input
          id={ids.everyone}
          type="checkbox"
          data-testid="availability-everyone"
          checked={value.everyone}
          onChange={(e) => onChange({ ...value, everyone: e.target.checked })}
        />
        <span>{t('everyone')}</span>
      </label>

      <div>
        <p className="text-xs text-[color:var(--fg-muted)]">{t('principalsHint')}</p>
        {value.principals.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-1" data-testid="availability-principals">
            {value.principals.map((p) => (
              <li
                key={p}
                className="flex items-center gap-1 rounded-full border border-[color:var(--border)] px-2 py-0.5 text-xs"
              >
                <code>{p}</code>
                {/* eslint-disable-next-line no-restricted-syntax -- chip remove control, not a §4.2 CTA */}
                <button
                  type="button"
                  aria-label={t('removePrincipal', { principal: p })}
                  onClick={() =>
                    onChange({
                      ...value,
                      principals: value.principals.filter((x) => x !== p),
                    })
                  }
                  className="text-[color:var(--fg-muted)] hover:text-[color:var(--danger)]"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex gap-2">
          <label className="sr-only" htmlFor={ids.principal}>
            {t('principalLabel')}
          </label>
          <input
            id={ids.principal}
            type="text"
            data-testid="availability-principal-input"
            value={principal}
            placeholder={t('principalPlaceholder')}
            onChange={(e) => {
              setPrincipal(e.target.value);
              setPrincipalError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPrincipal();
              }
            }}
            className={inputCls}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="availability-principal-add"
            onClick={addPrincipal}
            disabled={principal.trim() === ''}
          >
            {t('addPrincipal')}
          </Button>
        </div>
        {principalError && (
          <p
            role="alert"
            className="mt-1 text-xs text-[color:var(--danger)]"
            data-testid="availability-principal-error"
          >
            {t('principalInvalid')}
          </p>
        )}
      </div>

      <label className="flex items-center gap-2" htmlFor={ids.restrict}>
        <input
          id={ids.restrict}
          type="checkbox"
          data-testid="availability-restrict-channels"
          checked={value.channels !== null}
          onChange={(e) =>
            onChange({
              ...value,
              channels: e.target.checked ? channelList(channelsText) : null,
            })
          }
        />
        <span>{t('restrictChannels')}</span>
      </label>
      {value.channels !== null && (
        <div>
          <label className="block text-xs text-[color:var(--fg-muted)]" htmlFor={ids.channels}>
            {t('channelsLabel')}
          </label>
          <input
            id={ids.channels}
            type="text"
            data-testid="availability-channels"
            value={channelsText}
            placeholder={t('channelsPlaceholder')}
            onChange={(e) => {
              setChannelsText(e.target.value);
              onChange({ ...value, channels: channelList(e.target.value) });
            }}
            className={inputCls}
          />
        </div>
      )}

      {!reachesAnybody(value) && (
        <p className="text-xs text-[color:var(--warning)]" data-testid="availability-nobody">
          {t('reachesNobody')}
        </p>
      )}
    </fieldset>
  );
}
