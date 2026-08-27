import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import {
  DashboardOnboarding,
  __resetOnboardingStores,
} from '../DashboardOnboarding';

/**
 * OM-01/12 — onboarding started at "Schritt 2" and never showed progress.
 *
 * The card was titled "Erste Schritte" and the first visible content was
 * "SCHRITT 2 · BUSINESS-CASE WÄHLEN". No step 1 existed, because the three
 * `t('step', {n})` calls lived inside a mutually-exclusive ternary: step 1
 * VANISHED once satisfied instead of being checked off. The card also stayed
 * unchanged after the tester installed plugins and worked in admin — because
 * `selectedCaseId` was plain `useState` and reset on every navigation. And it
 * never mentioned the actual blocker, LLM access.
 */

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => <a href={href}>{children}</a>,
}));

vi.mock('../../admin/SkillImportModal', () => ({
  SkillImportModal: (): React.ReactElement => <div />,
}));

function renderCard(
  over: Partial<{
    llmVerified: boolean;
    cliLoggedIn: boolean;
    hasInstalledPlugin: boolean;
  }> = {},
) {
  return renderWithIntl(
    <DashboardOnboarding
      plugins={[]}
      llmVerified={false}
      cliLoggedIn={false}
      hasInstalledPlugin={false}
      {...over}
    />,
    { locale: 'de' },
  );
}

describe('<DashboardOnboarding /> — OM-01/12 step model', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetOnboardingStores();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders all three steps, always — numbering starts at 1', () => {
    renderCard();

    expect(screen.getByTestId('onboarding-step-1')).toBeTruthy();
    expect(screen.getByTestId('onboarding-step-2')).toBeTruthy();
    expect(screen.getByTestId('onboarding-step-3')).toBeTruthy();
    expect(screen.getByText(/Schritt 1 von 3/)).toBeTruthy();
  });

  it('step 1 is CHECKED, not hidden, when a verified provider exists', () => {
    renderCard({ llmVerified: true });

    const step1 = screen.getByTestId('onboarding-step-1');
    // The whole point: satisfied ≠ gone.
    expect(step1).toBeTruthy();
    expect(step1.dataset['done']).toBe('true');
    expect(screen.getByTestId('onboarding-step-1-check')).toBeTruthy();
  });

  it('step 1 stays OPEN when the provider is merely unverified', () => {
    // `llmVerified` is false for `status: 'unverified'` — a stored key that was
    // never probed is exactly the state that used to render as "VERBUNDEN"
    // while every request failed with `invalid x-api-key`.
    renderCard({ llmVerified: false });

    const step1 = screen.getByTestId('onboarding-step-1');
    expect(step1.dataset['done']).toBe('false');
    expect(screen.queryByTestId('onboarding-step-1-check')).toBeNull();
  });

  it('shows both step-1 CTAs for API keys and subscriptions', () => {
    renderCard();

    const step1 = screen.getByTestId('onboarding-step-1');
    const links = Array.from(step1.querySelectorAll('a'));
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      expect.arrayContaining([
        '/admin/providers',
        '/admin/providers?tab=subscriptions',
      ]),
    );
    expect(screen.getByText(/API-Schlüssel hinterlegen/)).toBeTruthy();
    expect(screen.getByText(/Abo verwenden/)).toBeTruthy();
  });

  it('a logged-in subscription CLI also satisfies step 1', () => {
    renderCard({ cliLoggedIn: true });

    expect(screen.getByTestId('onboarding-step-1').dataset['done']).toBe('true');
    expect(screen.getByText(/Abo-CLI angemeldet/)).toBeTruthy();
  });

  it('shows overall progress', () => {
    renderCard({ llmVerified: true, hasInstalledPlugin: true });
    expect(screen.getByText(/2 von 3 erledigt/)).toBeTruthy();
  });

  it('the selected business case survives a remount', () => {
    const first = renderCard({ llmVerified: true });
    // Pick the first case card.
    const caseButton = screen.getByText('Vertrieb & CRM').closest('button');
    expect(caseButton).toBeTruthy();
    fireEvent.click(caseButton as HTMLElement);

    expect(screen.getByTestId('onboarding-step-2').dataset['done']).toBe('true');
    first.unmount();

    // A navigation used to wipe this, which is why the card looked identical
    // after the tester had done half an hour of work.
    __resetOnboardingStores();
    renderCard({ llmVerified: true });
    expect(screen.getByTestId('onboarding-step-2').dataset['done']).toBe('true');
    expect(screen.getByText(/Business-Case: Vertrieb & CRM/)).toBeTruthy();
  });
});
