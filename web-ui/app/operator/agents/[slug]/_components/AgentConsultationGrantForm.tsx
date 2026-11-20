'use client';

import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import type { OperatorAgentDto } from '../../../../_lib/agents';
import {
  DISCLOSURE_LEVELS,
  MEMORY_ACCESS_MODES,
  type ConsultationGrantDto,
  type ConsultationGrantInput,
  type DisclosureLevel,
  type MemoryAccessMode,
} from '../../../../_lib/consultation';

/** Disclosure keys the form edits; other keys of a stored grant are kept. */
export const FORM_DISCLOSURE_KEYS = ['context', 'default'] as const;
type FormDisclosureKey = (typeof FORM_DISCLOSURE_KEYS)[number];

const MAX_CALLS_PER_TURN = 10;
const MAX_CALLS_PER_DAY = 10_000;
const DEFAULT_CALLS_PER_TURN = 2;
const DEFAULT_CALLS_PER_DAY = 50;

interface GrantFormProps {
  /** The agent that asks (A). */
  readonly self: OperatorAgentDto;
  /** Agents a grant may name as B: enabled, not facilitators, not A. */
  readonly targets: readonly OperatorAgentDto[];
  /** The grant being edited, or null for a new one. */
  readonly editing: ConsultationGrantDto | null;
  readonly busy: boolean;
  readonly onSubmit: (to: string, input: ConsultationGrantInput) => void;
  readonly onCancel: () => void;
}

/** Plugin ids an agent holds an enabled grant for. */
function enabledPlugins(agent: OperatorAgentDto | undefined): Set<string> {
  return new Set((agent?.plugins ?? []).filter((p) => p.enabled).map((p) => p.id));
}

function clampInt(raw: string, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

/**
 * Spec 2042 §5.4 — the form for one directed grant A → B. Capabilities are
 * derived, never typed: the runtime envelope is `grant ∩ A's grants ∩ B's
 * grants`, so only plugins both agents hold enabled are offered.
 */
export function AgentConsultationGrantForm(props: GrantFormProps): React.ReactElement {
  const t = useTranslations('operatorAgents.consultation');
  const { editing } = props;
  const [to, setTo] = useState(editing?.to ?? '');
  const [capabilities, setCapabilities] = useState<string[]>(editing ? [...editing.allowedCapabilities] : []);
  const [memoryAccess, setMemoryAccess] = useState<MemoryAccessMode>(editing?.memoryAccess ?? 'none');
  const [disclosure, setDisclosure] = useState<Record<string, DisclosureLevel>>(editing?.disclosure ?? {});
  const [perTurn, setPerTurn] = useState(String(editing?.maxCallsPerTurn ?? DEFAULT_CALLS_PER_TURN));
  const [perDay, setPerDay] = useState(String(editing?.maxCallsPerDay ?? DEFAULT_CALLS_PER_DAY));

  const target = props.targets.find((a) => a.slug === to);
  const shared = useMemo(() => {
    const mine = enabledPlugins(props.self);
    const theirs = enabledPlugins(target);
    return [...mine].filter((id) => theirs.has(id)).sort();
  }, [props.self, target]);

  const toggleCapability = (id: string, on: boolean): void => {
    setCapabilities((prev) => (on ? [...prev.filter((c) => c !== id), id] : prev.filter((c) => c !== id)));
  };

  const setLevel = (key: FormDisclosureKey, level: DisclosureLevel): void => {
    setDisclosure((prev) => ({ ...prev, [key]: level }));
  };

  const submit = (): void => {
    if (!to) return;
    props.onSubmit(to, {
      allowedCapabilities: capabilities.filter((c) => shared.includes(c)),
      memoryAccess,
      disclosure,
      maxCallsPerTurn: clampInt(perTurn, MAX_CALLS_PER_TURN, DEFAULT_CALLS_PER_TURN),
      maxCallsPerDay: clampInt(perDay, MAX_CALLS_PER_DAY, DEFAULT_CALLS_PER_DAY),
    });
  };

  const selectClass = 'rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm';

  return (
    <div className="mt-3 flex flex-col gap-3 rounded border border-[color:var(--border)]/60 p-3">
      <h4 className="text-sm font-medium text-[color:var(--fg-strong)]">
        {editing ? t('formEditHeading', { agent: editing.to }) : t('formNewHeading')}
      </h4>

      <label className="flex flex-col text-xs">
        <span className="mb-1 text-[color:var(--fg-muted)]">{t('targetLabel')}</span>
        <select
          className={selectClass}
          value={to}
          disabled={props.busy || editing !== null}
          onChange={(e) => {
            setTo(e.target.value);
            setCapabilities([]);
          }}
        >
          <option value="">{props.targets.length === 0 ? t('targetNone') : t('targetPlaceholder')}</option>
          {props.targets.map((a) => (
            <option key={a.slug} value={a.slug}>
              {t('targetOption', { name: a.name, slug: a.slug })}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex flex-col gap-1 text-xs">
        <legend className="mb-1 text-[color:var(--fg-muted)]">{t('capabilitiesLabel')}</legend>
        <p className="text-[color:var(--fg-muted)]">{t('capabilitiesHint')}</p>
        {!to ? null : shared.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('capabilitiesNone')}</p>
        ) : (
          shared.map((id) => (
            <label key={id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={capabilities.includes(id)}
                disabled={props.busy}
                onChange={(e) => toggleCapability(id, e.target.checked)}
              />
              <code className="text-xs">{id}</code>
            </label>
          ))
        )}
      </fieldset>

      <label className="flex flex-col text-xs">
        <span className="mb-1 text-[color:var(--fg-muted)]">{t('memoryAccessLabel')}</span>
        <select
          className={selectClass}
          value={memoryAccess}
          disabled={props.busy}
          onChange={(e) => setMemoryAccess(e.target.value as MemoryAccessMode)}
        >
          {MEMORY_ACCESS_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`memoryAccess.${m}`)}
            </option>
          ))}
        </select>
        <span className="mt-1 text-[color:var(--fg-muted)]">{t('memoryAccessHint')}</span>
      </label>

      <fieldset className="flex flex-col gap-2 text-xs">
        <legend className="mb-1 text-[color:var(--fg-muted)]">{t('disclosureLabel')}</legend>
        <p className="text-[color:var(--fg-muted)]">{t('disclosureHint')}</p>
        {FORM_DISCLOSURE_KEYS.map((key) => (
          <label key={key} className="flex flex-wrap items-center gap-2">
            <span className="min-w-48">{t(`disclosureKeys.${key}`)}</span>
            <select
              className={selectClass}
              value={disclosure[key] ?? 'none'}
              disabled={props.busy}
              onChange={(e) => setLevel(key, e.target.value as DisclosureLevel)}
            >
              {DISCLOSURE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`disclosureLevels.${level}`)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex flex-col">
          <span className="mb-1 text-[color:var(--fg-muted)]">{t('perTurnLabel', { max: MAX_CALLS_PER_TURN })}</span>
          <input
            type="number"
            min={1}
            max={MAX_CALLS_PER_TURN}
            className={`${selectClass} w-24`}
            value={perTurn}
            disabled={props.busy}
            onChange={(e) => setPerTurn(e.target.value)}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-1 text-[color:var(--fg-muted)]">{t('perDayLabel', { max: MAX_CALLS_PER_DAY })}</span>
          <input
            type="number"
            min={1}
            max={MAX_CALLS_PER_DAY}
            className={`${selectClass} w-28`}
            value={perDay}
            disabled={props.busy}
            onChange={(e) => setPerDay(e.target.value)}
          />
        </label>
      </div>

      <div className="flex gap-2">
        <Button size="sm" busy={props.busy} busyLabel={t('saving')} disabled={!to || props.busy} onClick={submit}>
          {t('save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
