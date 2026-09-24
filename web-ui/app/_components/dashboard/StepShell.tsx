'use client';

import { Check, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * OM-01/12 — the shared frame for an onboarding step: number, "n of total", a
 * checkmark when done, and the step's own content.
 *
 * The old card had three bare `t('step', {n})` labels inside a ternary, so the
 * user saw a number with nothing to compare it to and no indication that
 * anything had been achieved. `n of total` and the checked state are the whole
 * point of this component.
 *
 * Lives in its own file so `DashboardOnboarding.tsx` stays under the size
 * limit; the step BODIES (e.g. `LlmStep.tsx`) are siblings.
 */
export interface StepShellProps {
  readonly n: number;
  readonly total: number;
  readonly done: boolean;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly children: React.ReactNode;
}

export function StepShell({
  n,
  total,
  done,
  icon: Icon,
  title,
  children,
}: StepShellProps): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  return (
    <div
      data-testid={`onboarding-step-${n}`}
      data-done={done ? 'true' : 'false'}
      className={`mt-6 rounded-lg border p-5 ${
        done
          ? 'border-[color:var(--border)] bg-[color:var(--card)]/40'
          : 'border-[color:var(--accent)]/50 bg-[color:var(--accent-subtle)]'
      }`}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em]">
        {done ? (
          <Check
            className="size-3.5 text-[color:var(--success)]"
            aria-hidden
            data-testid={`onboarding-step-${n}-check`}
          />
        ) : (
          <Icon className="size-3.5 text-[color:var(--accent)]" aria-hidden />
        )}
        <span
          className={
            done
              ? 'text-[color:var(--fg-subtle)]'
              : 'text-[color:var(--accent)]'
          }
        >
          {t('stepOfTotal', { n, total })}
        </span>
        {done ? (
          <span className="text-[color:var(--success)]">{t('applied')}</span>
        ) : null}
      </div>
      <h3 className="font-display mt-1 text-lg font-medium text-[color:var(--fg-strong)]">
        {title}
      </h3>
      {children}
    </div>
  );
}
