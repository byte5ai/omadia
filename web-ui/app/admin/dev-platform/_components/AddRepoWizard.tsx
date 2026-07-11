'use client';

import { useCallback, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { CredentialStep, type CredentialChoice } from './CredentialStep';
import { ProtectionCheckList } from './ProtectionCheckList';
import { createRepo, type DevRepoView } from '../_lib/api';

/**
 * Epic #470 W0 — the add-repo wizard (UI spec §3). Own page, not a modal —
 * device flow leaves for github.com. A vertical step sequence: completed steps
 * collapse to a one-line summary with a ghost "Edit"; the active step is
 * expanded. No spinner — the "Add repository" button uses `Button busy`.
 *
 * Spec drift (recorded): the spec's independent step-3 "Checks" assumes a
 * pre-creation branch-protection probe. The W0 backend on this branch folds
 * access validation AND the branch-protection check into `POST /repos` (it
 * needs the stored credential to probe), and exposes no pre-creation check
 * endpoint. So the wizard runs the check AS PART OF add and renders the verdict
 * immediately after — which still satisfies "the check runs in the wizard,
 * warns loudly, does not block".
 */

type Step = 'repo' | 'credentials' | 'confirm';
const ORDER: readonly Step[] = ['repo', 'credentials', 'confirm'];

const inputCls =
  'rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export function AddRepoWizard(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard');
  const [step, setStep] = useState<Step>('repo');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [credential, setCredential] = useState<CredentialChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [created, setCreated] = useState<DevRepoView | null>(null);

  const repoReady = owner.trim().length > 0 && name.trim().length > 0;
  const credentialReady =
    credential?.kind === 'pat'
      ? credential.token.trim().length > 0
      : credential?.kind === 'device_flow'
        ? credential.authorized
        : false;

  const go = useCallback((next: Step) => {
    setStep(next);
    setErrorKey(null);
  }, []);

  const submit = useCallback(() => {
    if (!credential || (credential.kind !== 'device_flow' && credential.kind !== 'pat')) return;
    setSubmitting(true);
    setErrorKey(null);
    void (async () => {
      try {
        const body =
          credential.kind === 'pat'
            ? { owner: owner.trim(), name: name.trim(), credential: { kind: 'pat' as const, token: credential.token } }
            : { owner: owner.trim(), name: name.trim(), credential: { kind: 'device_flow' as const } };
        const repo = await createRepo(body);
        setCreated(repo);
      } catch {
        setErrorKey('submit');
      } finally {
        setSubmitting(false);
      }
    })();
  }, [credential, owner, name]);

  // Success view — repo created, protection verdict shown (does not block).
  if (created) {
    return (
      <div className="mx-auto max-w-2xl">
        <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">{t('done.heading')}</h2>
        <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
          {t('done.body', { repo: `${created.owner}/${created.name}` })}
        </p>
        <div className="mt-4 rounded-lg border border-[color:var(--border)] p-4">
          <ProtectionCheckList branch={created.defaultBranch} ok={created.branchProtectionOk} />
        </div>
        <div className="mt-6 flex gap-2">
          <Link href="/admin/dev-platform?tab=repos">
            <Button variant="primary">{t('done.toList')}</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* Step 1 — Repository */}
      <StepShell
        index={1}
        title={t('steps.repo')}
        active={step === 'repo'}
        done={step !== 'repo'}
        summary={repoReady ? `github · ${owner}/${name}` : ''}
        onEdit={() => go('repo')}
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[color:var(--fg-muted)]">{t('fields.forge')}</span>
            <select className={inputCls} value="github" disabled>
              <option value="github">GitHub</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[color:var(--fg-muted)]">{t('fields.owner')}</span>
            <input className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="acme" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[color:var(--fg-muted)]">{t('fields.name')}</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="api" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[color:var(--fg-muted)]">{t('fields.branch')}</span>
            <input className={inputCls} value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
          </label>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" disabled={!repoReady} onClick={() => go('credentials')}>
              {t('next')}
            </Button>
          </div>
        </div>
      </StepShell>

      {/* Step 2 — Credentials */}
      <StepShell
        index={2}
        title={t('steps.credentials')}
        active={step === 'credentials'}
        done={ORDER.indexOf(step) > ORDER.indexOf('credentials')}
        summary={credentialReady && credential ? t(`summary.${credential.kind}`) : ''}
        onEdit={() => go('credentials')}
      >
        <CredentialStep onChange={setCredential} />
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" size="sm" onClick={() => go('repo')}>
            {t('back')}
          </Button>
          <Button variant="primary" size="sm" disabled={!credentialReady} onClick={() => go('confirm')}>
            {t('next')}
          </Button>
        </div>
      </StepShell>

      {/* Step 3 — Confirm */}
      <StepShell index={3} title={t('steps.confirm')} active={step === 'confirm'} done={false} summary="" onEdit={() => go('confirm')}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[color:var(--fg-subtle)]">{t('fields.owner')}</dt>
          <dd className="font-mono">{owner}</dd>
          <dt className="text-[color:var(--fg-subtle)]">{t('fields.name')}</dt>
          <dd className="font-mono">{name}</dd>
          <dt className="text-[color:var(--fg-subtle)]">{t('fields.branch')}</dt>
          <dd className="font-mono">{defaultBranch}</dd>
          <dt className="text-[color:var(--fg-subtle)]">{t('steps.credentials')}</dt>
          <dd className="font-mono">{credential ? t(`summary.${credential.kind}`) : ''}</dd>
        </dl>
        {credential?.kind === 'device_flow' ? (
          <div className="mt-3 border-l-2 border-l-[color:var(--warning)] pl-3 text-xs text-[color:var(--fg)]">
            {t('credentials.deviceTradeoffs.canMerge')}
          </div>
        ) : null}
        {errorKey ? <p className="mt-3 text-sm text-[color:var(--danger)]">{t('error.submit')}</p> : null}
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" size="sm" onClick={() => go('credentials')}>
            {t('back')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            busy={submitting}
            busyLabel={t('adding')}
            disabled={!credentialReady || !repoReady}
            onClick={submit}
          >
            {t('finish')}
          </Button>
        </div>
      </StepShell>
    </div>
  );
}

function StepShell({
  index,
  title,
  active,
  done,
  summary,
  onEdit,
  children,
}: {
  index: number;
  title: string;
  active: boolean;
  done: boolean;
  summary: string;
  onEdit: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard');
  if (!active && done) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-[color:var(--border)] px-4 py-2">
        <span className="text-sm text-[color:var(--fg-muted)]">
          <span aria-hidden>✓ </span>
          {index}. {title}
          {summary ? <span className="ml-2 font-mono text-xs text-[color:var(--fg-subtle)]">{summary}</span> : null}
        </span>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          {t('edit')}
        </Button>
      </div>
    );
  }
  return (
    <section className={`rounded-lg border p-4 ${active ? 'lume-border-default' : 'border-[color:var(--border)] opacity-60'}`}>
      <h3 tabIndex={-1} className="mb-3 text-sm font-semibold text-[color:var(--fg-strong)]">
        {index}. {title}
      </h3>
      {active ? children : null}
    </section>
  );
}
