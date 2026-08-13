import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { APP_VERSION } from '../_lib/appVersion';

/**
 * OM-09 — in-product help.
 *
 * There was none. No help route, no `?` affordance, no mailto, no docs link, no
 * search anywhere in the shell. A customer who hit an invalid API key had no
 * path from "this is broken" to "here is what to do", and wrote: "Klingt blöd,
 * aber ein Hilfebot wäre jetzt echt super."
 *
 * This is the minimum viable version, deliberately NOT the bot. An
 * agent-powered help bot has to work precisely when the customer's own LLM key
 * is broken — the state that generates most help requests — which means it
 * needs a byte5-operated LLM path. That is an infrastructure and product
 * decision, not something to smuggle in here.
 *
 * The FAQ covers exactly the states this bug report exposed, so the page earns
 * its place instead of being a generic link farm.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('help');
  return { title: t('metaTitle') };
}

const DOCS_URL = 'https://github.com/byte5ai/omadia/tree/main/docs';
const REPO_URL = 'https://github.com/byte5ai/omadia';
const ISSUES_URL = 'https://github.com/byte5ai/omadia/issues';
const DISCUSSIONS_URL = 'https://github.com/byte5ai/omadia/discussions';

/** FAQ entries. `href` points at the page that actually resolves the state. */
const FAQ = [
  { key: 'invalidKey', href: '/admin/providers' },
  { key: 'pluginNeedsConfig', href: '/store' },
  { key: 'cliNotInstalled', href: '/admin/providers' },
  { key: 'noModels', href: '/admin/providers' },
] as const;

export default async function HelpPage(): Promise<React.ReactElement> {
  const t = await getTranslations('help');

  return (
    <main className="mx-auto w-full max-w-[900px] px-6 py-12 lg:px-8 lg:py-16">
      <header>
        <div className="text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          {t('kicker')}
        </div>
        <h1 className="mt-3 text-[32px] font-semibold leading-tight text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('faq.heading')}
        </h2>
        <ul className="mt-4 flex flex-col gap-3">
          {FAQ.map((entry) => (
            <li
              key={entry.key}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 px-4 py-4"
            >
              <h3 className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
                {t(`faq.${entry.key}.question`)}
              </h3>
              <p className="mt-2 text-sm leading-[1.55] text-[color:var(--fg-muted)]">
                {t(`faq.${entry.key}.answer`)}
              </p>
              <p className="mt-2 text-sm">
                <Link
                  href={entry.href}
                  className="font-medium text-[color:var(--accent)] underline"
                >
                  {t(`faq.${entry.key}.action`)} →
                </Link>
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('docs.heading')}
        </h2>
        <ul className="mt-4 flex flex-col gap-2 text-sm">
          <li>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[color:var(--accent)] underline"
            >
              {t('docs.documentation')}
            </a>
          </li>
          <li>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[color:var(--accent)] underline"
            >
              {t('docs.repository')}
            </a>
          </li>
          <li>
            <a
              href={DISCUSSIONS_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[color:var(--accent)] underline"
            >
              {t('docs.discussions')}
            </a>
          </li>
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('support.heading')}
        </h2>
        <p className="mt-3 text-sm leading-[1.55] text-[color:var(--fg-muted)]">
          {t('support.body')}
        </p>
        <p className="mt-3 text-sm">
          <a
            href={ISSUES_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[color:var(--accent)] underline"
          >
            {t('support.openIssue')} →
          </a>
        </p>
      </section>

      <section className="mt-12 border-t border-[color:var(--border)] pt-6">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('build.heading')}
        </h2>
        {/* Include this when reporting a problem — a version number turns
            "it doesn't work" into a reproducible report. */}
        <p className="mt-3 font-mono-num text-sm text-[color:var(--fg-muted)]">
          {t('build.version', { version: APP_VERSION })}
        </p>
      </section>
    </main>
  );
}
