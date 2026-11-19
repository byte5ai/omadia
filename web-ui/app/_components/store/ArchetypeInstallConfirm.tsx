'use client';

/**
 * #2088 — the explicit confirmation before an archetype plugin is installed.
 *
 * An archetype plugin adds a new kind of agent to the instance. What agents
 * of it may do is decided by the archetype's descriptor, not by grants the
 * operator gives per agent, so the operator sees that descriptor before the
 * install starts: what the archetype adds, what its agents never get and what
 * such an agent needs. The lists are the ones the middleware will enforce (it
 * sends them with the refusal that asks for this confirmation).
 */

import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  KNOWN_ARCHETYPE_ADDITIONS,
  KNOWN_ARCHETYPE_OMISSIONS,
  KNOWN_ARCHETYPE_REQUIREMENTS,
  archetypeText,
  isKnownCode,
  type PluginArchetype,
} from '@/app/_lib/archetypes';

export function ArchetypeInstallConfirm({
  pluginName,
  archetype,
  busy,
  onConfirm,
  onCancel,
}: {
  pluginName: string;
  archetype: PluginArchetype;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const t = useTranslations('store.install.archetypeConfirm');
  const locale = useLocale();
  const name = archetypeText(archetype.label, locale) ?? archetype.id;
  const description = archetypeText(archetype.description, locale);

  /** A code this build has a sentence for, else the code itself in the generic line. */
  const line = (group: 'omissions' | 'additions' | 'requirements', known: readonly string[], code: string): string =>
    isKnownCode(known, code) ? t(`${group}.${code}`) : t('unknownEntry', { code });

  return (
    <div className="space-y-5" data-testid="archetype-install-confirm">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-[color:var(--ink)]">{t('title', { name })}</h3>
        <p className="text-sm text-[color:var(--muted-ink)]">{t('lead', { plugin: pluginName, name })}</p>
        {description ? <p className="text-sm text-[color:var(--ink)]">{description}</p> : null}
      </div>

      <DescriptorList
        heading={t('addsHeading')}
        empty={t('addsEmpty')}
        testId="archetype-adds"
        items={archetype.adds.map((code) => line('additions', KNOWN_ARCHETYPE_ADDITIONS, code))}
      />
      <DescriptorList
        heading={t('omitsHeading')}
        empty={t('omitsEmpty')}
        testId="archetype-omits"
        items={archetype.omits.map((code) => line('omissions', KNOWN_ARCHETYPE_OMISSIONS, code))}
      />
      {archetype.requires.length > 0 ? (
        <DescriptorList
          heading={t('requiresHeading')}
          empty=""
          testId="archetype-requires"
          items={archetype.requires.map((code) => line('requirements', KNOWN_ARCHETYPE_REQUIREMENTS, code))}
        />
      ) : null}

      <p className="text-sm text-[color:var(--muted-ink)]">{t('note')}</p>

      <div className="flex flex-wrap gap-3">
        <Button variant="primary" pill onClick={onConfirm} disabled={busy}>
          {busy ? t('confirming') : t('confirm', { name })}
        </Button>
        <Button variant="secondary" pill onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

function DescriptorList({
  heading,
  empty,
  items,
  testId,
}: {
  heading: string;
  empty: string;
  items: readonly string[];
  testId: string;
}): React.ReactElement {
  return (
    <section className="space-y-1" data-testid={testId}>
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--muted-ink)]">{heading}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-[color:var(--muted-ink)]">{empty}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm text-[color:var(--ink)]">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
