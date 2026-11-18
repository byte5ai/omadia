'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import type { OperatorAgentDto } from '../../../_lib/agents';
import {
  FacilitationEngineNotice,
  FacilitatorReadiness,
  useFacilitationEngine,
  useFacilitatorTeamsState,
  type FacilitationEngineLoad,
} from './facilitatorReadiness';

/**
 * #2066 — "Facilitators" next to "Orchestrators" in the agent directory
 * (spec 2043 §7).
 *
 * A facilitator is an agent of its own kind: named, with its own avatar,
 * personality and Teams identity, and WITHOUT what would make it partial
 * (spec §2.3). So its card carries no plugin editor, no bindings and no
 * memory scope — those are not hidden features, the kernel refuses them —
 * and says so in one line instead of leaving a gap.
 *
 * Creating one here writes the agent row with `kind: 'facilitator'`, which
 * is fixed for its lifetime. Avatar, personality and the Teams identity are
 * set on its own page, where the same editors a standard agent uses run
 * inside the facilitator's bounds; the parent navigates there after create.
 */
interface FacilitatorsSectionProps {
  readonly facilitators: readonly OperatorAgentDto[];
  readonly disabled: boolean;
  readonly onCreate: (input: {
    slug: string;
    name: string;
    description?: string;
  }) => void;
  readonly onToggleStatus: (agent: OperatorAgentDto) => void;
  readonly onDelete: (agent: OperatorAgentDto) => void;
}

const INPUT_CLASS =
  'w-full rounded border border-[color:var(--border)] px-2 py-1 text-sm';
const FIELD_LABEL_CLASS =
  'text-xs uppercase tracking-wide text-[color:var(--fg-muted)]';

export function FacilitatorsSection(
  props: FacilitatorsSectionProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator');
  const engine = useFacilitationEngine();

  return (
    <section className="space-y-4" data-testid="facilitators-section">
      <div>
        <h2 className="text-lg font-medium">
          {t('heading')}{' '}
          <span className="text-sm font-normal text-[color:var(--fg-muted)]">
            ({props.facilitators.length})
          </span>
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </div>

      <FacilitationEngineNotice engine={engine} />

      <CreateFacilitatorForm disabled={props.disabled} onCreate={props.onCreate} />

      {props.facilitators.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        props.facilitators.map((agent) => (
          <FacilitatorCard
            key={agent.id}
            agent={agent}
            engine={engine}
            disabled={props.disabled}
            onToggleStatus={() => props.onToggleStatus(agent)}
            onDelete={() => props.onDelete(agent)}
          />
        ))
      )}
    </section>
  );
}

function CreateFacilitatorForm(props: {
  readonly disabled: boolean;
  readonly onCreate: FacilitatorsSectionProps['onCreate'];
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <h3 className="mb-1 text-base font-medium">{t('facilitator.createHeading')}</h3>
      <p className="mb-4 text-xs text-[color:var(--fg-muted)]">
        {t('facilitator.createHint')}
      </p>
      <form
        className="grid gap-4 lg:grid-cols-3"
        data-testid="facilitator-create-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!slug || !name) return;
          props.onCreate({
            slug,
            name,
            ...(description ? { description } : {}),
          });
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>{t('fieldSlug')}</span>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="^[a-z0-9][a-z0-9-]*$"
            required
            className={INPUT_CLASS}
            data-testid="facilitator-create-slug"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>{t('fieldName')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className={INPUT_CLASS}
            data-testid="facilitator-create-name"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>{t('fieldDescription')}</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={INPUT_CLASS}
          />
        </label>
        <div className="lg:col-span-3">
          <Button
            type="submit"
            variant="primary"
            disabled={props.disabled || !slug || !name}
          >
            {t('facilitator.createSubmit')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function FacilitatorCard(props: {
  readonly agent: OperatorAgentDto;
  readonly engine: FacilitationEngineLoad;
  readonly disabled: boolean;
  readonly onToggleStatus: () => void;
  readonly onDelete: () => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const { agent } = props;
  const teams = useFacilitatorTeamsState(agent.slug);

  return (
    <article
      data-testid={`facilitator-card-${agent.slug}`}
      className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[16rem] flex-1 space-y-1">
          <p className="text-base font-semibold">
            {agent.name}{' '}
            <span className="font-mono text-sm text-[color:var(--fg-muted)]">
              ({agent.slug})
            </span>
          </p>
          <p className="text-xs text-[color:var(--fg-muted)]">
            {t('facilitator.cardSummary', {
              status:
                agent.status === 'enabled'
                  ? t('statusEnabled')
                  : t('statusDisabled'),
              runtime: agent.active ? t('runtimeActive') : t('runtimeInactive'),
            })}
          </p>
          {agent.description && <p className="text-sm">{agent.description}</p>}
          <FacilitatorReadiness agent={agent} teams={teams} engine={props.engine} />
          <p className="text-[11px] text-[color:var(--fg-muted)]">
            {t('facilitator.omittedNote')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/operator/agents/${encodeURIComponent(agent.slug)}`}
            className="text-sm text-[color:var(--accent)] hover:underline"
          >
            {t('detailOpenLink')}
          </Link>
          <Button
            variant="secondary"
            size="sm"
            disabled={props.disabled}
            onClick={props.onToggleStatus}
          >
            {agent.status === 'enabled' ? t('actionDisable') : t('actionEnable')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={props.disabled}
            onClick={() => {
              if (confirm(t('facilitator.deleteConfirm', { slug: agent.slug })))
                props.onDelete();
            }}
          >
            {t('actionDelete')}
          </Button>
        </div>
      </div>
    </article>
  );
}
