'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import type { OperatorAgentDto } from '../../../_lib/agents';
import { archetypeText, type OperatorArchetypeDto } from '../../../_lib/archetypes';

/**
 * #2088 — the directory section of ONE archetype (spec 2042 §5.10: "the
 * operator creates agents of it in its own section of the agent directory").
 *
 * Generic: name, description and what the archetype leaves out come from the
 * descriptor its plugin registered, so a new archetype gets a section without
 * a change to this app. The facilitator keeps its own section
 * (`FacilitatorsSection`), which additionally knows the facilitation engine
 * and the Teams readiness; every other archetype is shown by this one.
 *
 * An archetype NOBODY delivers any more (`archetype` absent, agents of it
 * still exist) keeps its section, without a create form: the kernel refuses
 * such agents everything until a plugin delivers the archetype again, and the
 * section says so instead of hiding them.
 */
interface ArchetypeSectionProps {
  readonly archetypeId: string;
  /** The registered descriptor; absent = no installed plugin delivers it. */
  readonly archetype?: OperatorArchetypeDto;
  readonly agents: readonly OperatorAgentDto[];
  readonly disabled: boolean;
  readonly onCreate: (input: { slug: string; name: string; description?: string }) => void;
  readonly onToggleStatus: (agent: OperatorAgentDto) => void;
  readonly onDelete: (agent: OperatorAgentDto) => void;
}

const INPUT_CLASS = 'w-full rounded border border-[color:var(--border)] px-2 py-1 text-sm';
const FIELD_LABEL_CLASS = 'text-xs uppercase tracking-wide text-[color:var(--fg-muted)]';

export function ArchetypeSection(props: ArchetypeSectionProps): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const locale = useLocale();
  const { archetype, archetypeId } = props;
  const name = archetypeText(archetype?.label, locale) ?? archetypeId;
  const heading = archetypeText(archetype?.label_plural, locale) ?? name;
  const description = archetypeText(archetype?.description, locale);

  return (
    <section className="space-y-4" data-testid={`archetype-section-${archetypeId}`}>
      <div>
        <h2 className="text-lg font-medium">
          {heading}{' '}
          <span className="text-sm font-normal text-[color:var(--fg-muted)]">({props.agents.length})</span>
        </h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-xs text-[color:var(--fg-muted)]">{description}</p>
        ) : null}
        <p className="mt-1 max-w-3xl text-xs text-[color:var(--fg-muted)]">
          {archetype
            ? archetype.plugin
              ? t('archetype.deliveredBy', { plugin: archetype.plugin.id })
              : t('archetype.deliveredByKernel')
            : t('archetype.notDelivered', { id: archetypeId })}
        </p>
      </div>

      {archetype ? (
        <CreateForm name={name} archetypeId={archetypeId} disabled={props.disabled} onCreate={props.onCreate} />
      ) : null}

      {props.agents.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('archetype.empty', { name })}</p>
      ) : (
        props.agents.map((agent) => (
          <article
            key={agent.id}
            data-testid={`archetype-agent-card-${agent.slug}`}
            className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-[16rem] flex-1 space-y-1">
                <p className="text-base font-semibold">
                  {agent.name}{' '}
                  <span className="font-mono text-sm text-[color:var(--fg-muted)]">({agent.slug})</span>
                </p>
                <p className="text-xs text-[color:var(--fg-muted)]">
                  {t('facilitator.cardSummary', {
                    status: agent.status === 'enabled' ? t('statusEnabled') : t('statusDisabled'),
                    runtime: agent.active ? t('runtimeActive') : t('runtimeInactive'),
                  })}
                </p>
                {agent.description ? <p className="text-sm">{agent.description}</p> : null}
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
                  onClick={() => props.onToggleStatus(agent)}
                >
                  {agent.status === 'enabled' ? t('actionDisable') : t('actionEnable')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={props.disabled}
                  onClick={() => {
                    if (confirm(t('archetype.deleteConfirm', { slug: agent.slug }))) props.onDelete(agent);
                  }}
                >
                  {t('actionDelete')}
                </Button>
              </div>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function CreateForm(props: {
  readonly name: string;
  readonly archetypeId: string;
  readonly disabled: boolean;
  readonly onCreate: ArchetypeSectionProps['onCreate'];
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <h3 className="mb-1 text-base font-medium">{t('archetype.createHeading', { name: props.name })}</h3>
      <p className="mb-4 text-xs text-[color:var(--fg-muted)]">{t('archetype.createHint')}</p>
      <form
        className="grid gap-4 lg:grid-cols-3"
        data-testid={`archetype-create-form-${props.archetypeId}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!slug || !name) return;
          props.onCreate({ slug, name, ...(description ? { description } : {}) });
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
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>{t('fieldName')}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={INPUT_CLASS} />
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
          <Button type="submit" variant="primary" disabled={props.disabled || !slug || !name}>
            {t('archetype.createSubmit', { name: props.name })}
          </Button>
        </div>
      </form>
    </div>
  );
}
