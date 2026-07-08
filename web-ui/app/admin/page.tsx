import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.index');
  return { title: t('metaTitle') };
}

/**
 * Admin landing page. The flat 15-card grid was consolidated into titled
 * groups (LLM Access, Knowledge & Memory, Plugins, Access, Danger Zone). Cards
 * are data-driven — copy lives in messages/{en,de}.json under `admin.index.*`;
 * this file only owns the href + i18n key + ordering.
 *
 * The `/admin/builder` route still exists for deep links but is no longer
 * advertised here — the canonical Builder entry point is the Plugins nav
 * (`/store/builder`).
 */
type CardDef = { readonly href: string; readonly key: string; readonly danger?: boolean };
type GroupDef = { readonly key: string; readonly cards: readonly CardDef[] };

const GROUPS: readonly GroupDef[] = [
  {
    key: 'llm',
    cards: [
      { href: '/admin/providers', key: 'llmAccess' },
      // Usage & cost is an LLM concern (token spend per model), so it lives
      // with LLM access. The former standalone "General" group (Configuration +
      // Usage) is gone — provider keys are now entered inline on LLM access.
      { href: '/admin/usage', key: 'usage' },
    ],
  },
  {
    key: 'knowledge',
    cards: [
      { href: '/admin/kg-lifecycle', key: 'kgLifecycle' },
      { href: '/admin/kg-priorities', key: 'kgPriorities' },
      { href: '/admin/bulk-promote', key: 'bulkPromote' },
      { href: '/admin/inconsistencies', key: 'inconsistencies' },
      { href: '/admin/memory-backend', key: 'memoryBackend' },
    ],
  },
  {
    key: 'plugins',
    cards: [
      { href: '/admin/domains', key: 'domains' },
      { href: '/admin/registries', key: 'registries' },
      { href: '/admin/mcp', key: 'mcp' },
    ],
  },
  {
    key: 'access',
    cards: [
      { href: '/admin/auth', key: 'auth' },
      { href: '/admin/users', key: 'users' },
    ],
  },
  {
    key: 'danger',
    cards: [{ href: '/admin/danger-zone', key: 'dangerZone', danger: true }],
  },
] as const;

export default async function AdminIndexPage(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.index');
  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('h1')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('subtitle')}
        </p>
      </header>

      <div className="flex flex-col gap-10">
        {GROUPS.map((group) => (
          <section key={group.key}>
            <h2 className="mb-3 text-xs font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
              {t(`groups.${group.key}.heading`)}
            </h2>
            <ul className="grid gap-4 lg:grid-cols-2">
              {group.cards.map((card) => (
                <AdminCard
                  key={card.key}
                  href={card.href}
                  title={t(`cards.${card.key}.title`)}
                  description={t(`cards.${card.key}.description`)}
                  danger={card.danger ?? false}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

function AdminCard({
  href,
  title,
  description,
  danger = false,
}: {
  href: string;
  title: string;
  description: string;
  danger?: boolean;
}): React.ReactElement {
  return (
    <li>
      <Link
        href={href}
        className={
          danger
            ? 'block rounded-lg border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/5 p-4 transition-colors hover:border-[color:var(--danger-edge)]'
            : 'block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]'
        }
      >
        <div
          className={
            danger
              ? 'text-[15px] font-semibold text-[color:var(--danger)]'
              : 'text-[15px] font-semibold text-[color:var(--fg-strong)]'
          }
        >
          {title}
        </div>
        <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{description}</p>
      </Link>
    </li>
  );
}
