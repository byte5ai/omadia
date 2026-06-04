'use client';

import { useTranslations } from 'next-intl';

import type { AgentSpecSkeleton } from '../../../../_lib/builderTypes';

interface SpecOverviewProps {
  spec: AgentSpecSkeleton;
  slots: Record<string, string>;
}

/**
 * Read-only summary of the current spec. Lives in the Spec/Slot tab area
 * during B.5-1 — a humane placeholder that proves the draft loaded and
 * gives the user something to look at before B.5-5 wires the structured
 * spec form and B.5-6 the Monaco slot editor.
 */
export function SpecOverview({ spec, slots }: SpecOverviewProps): React.ReactElement {
  const t = useTranslations('builder.spec.overview');
  const toolCount = spec.tools?.length ?? 0;
  const dependsOnCount = spec.depends_on?.length ?? 0;
  const setupFieldCount = spec.setup_fields?.length ?? 0;
  const slotKeys = Object.keys(slots);
  const slotCount = slotKeys.length;
  const networkCount = spec.network?.outbound?.length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
      <Field label={t('fields.agentId')} value={spec.id || '—'} mono />
      <Field label={t('fields.name')} value={spec.name || '—'} />
      <Field label={t('fields.version')} value={spec.version || '—'} mono />
      <Field label={t('fields.template')} value={spec.template ?? 'agent-integration'} mono />
      <Field label={t('fields.category')} value={spec.category || '—'} />
      <Field
        label={t('fields.domain')}
        value={spec.domain || '—'}
        mono
      />
      <Field
        label={t('fields.skillRole')}
        value={spec.skill?.role || '—'}
      />
      <Field
        label={t('fields.tools')}
        value={toolCount === 0 ? t('values.none') : `${toolCount}`}
      />
      <Field
        label={t('fields.slots')}
        value={slotCount === 0 ? t('values.none') : `${slotCount}`}
      />
      <Field
        label="depends_on"
        value={dependsOnCount === 0 ? '—' : `${dependsOnCount}`}
      />
      <Field
        label={t('fields.setupFields')}
        value={setupFieldCount === 0 ? t('values.none') : `${setupFieldCount}`}
      />
      <Field
        label={t('fields.outbound')}
        value={networkCount === 0 ? '—' : t('values.hosts', { count: networkCount })}
      />
      <Field
        label={t('fields.description')}
        value={spec.description || '—'}
        wide
      />
      {spec.playbook?.when_to_use ? (
        <Field
          label="when_to_use"
          value={spec.playbook.when_to_use}
          wide
        />
      ) : null}
      {slotCount > 0 ? (
        <div className="md:col-span-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
            {t('slotKeys')}
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {slotKeys.map((key) => (
              <li
                key={key}
                className="font-mono-num rounded-md bg-[color:var(--bg-soft)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)]"
              >
                {key}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}): React.ReactElement {
  return (
    <div className={wide ? 'md:col-span-2' : undefined}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {label}
      </p>
      <p
        className={[
          'mt-1 break-words text-[14px] text-[color:var(--fg-strong)]',
          mono ? 'font-mono-num' : '',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}
