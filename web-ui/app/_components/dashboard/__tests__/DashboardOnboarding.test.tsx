import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { Plugin } from '../../../_lib/storeTypes';
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

function plugin(over: Partial<Plugin> = {}): Plugin {
  return {
    id: '@omadia/channel-telegram',
    kind: 'channel',
    name: 'Telegram',
    version: '1.0.0',
    latest_version: '1.0.0',
    description: 'Telegram channel.',
    categories: [],
    integrations_summary: [],
    install_state: 'installed',
    ...over,
  } as Plugin;
}

function renderCard(
  over: Partial<{
    plugins: Plugin[] | null;
    llmVerified: boolean;
    cliLoggedIn: boolean;
    runtimeUp: boolean;
    assignedProviderKind: 'cli' | 'api' | null;
    embeddingsOff: boolean;
    hasInstalledPlugin: boolean;
  }> = {},
) {
  // OM-78 (#1001) — a stored access implies the runtime is up in the default
  // fixture, so the pre-existing step-model tests keep describing the happy
  // path. The OM-78 tests below set `runtimeUp` explicitly.
  const runtimeUp =
    over.runtimeUp ?? Boolean(over.llmVerified || over.cliLoggedIn);
  return renderWithIntl(
    <DashboardOnboarding
      plugins={[]}
      llmVerified={false}
      cliLoggedIn={false}
      assignedProviderKind={over.cliLoggedIn ? 'cli' : 'api'}
      embeddingsOff={false}
      hasInstalledPlugin={false}
      {...over}
      runtimeUp={runtimeUp}
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
});

/**
 * Round 4 (OM-74 / OM-78 / OM-84) — the card said "LLM verbunden · 3 von 3
 * erledigt" while the readiness banner on the same page said "LLM-Zugang
 * fehlt". Step 1 now ticks on the runtime, the done-copy follows the
 * orchestrator's assignment, and a missing embedding provider is named.
 */
describe('<DashboardOnboarding /> — round-4 readiness truth', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetOnboardingStores();
  });
  afterEach(() => {
    cleanup();
  });

  it('OM-78: step 1 stays OPEN while the runtime is down, even with a verified key', () => {
    renderCard({ llmVerified: true, runtimeUp: false });

    const step1 = screen.getByTestId('onboarding-step-1');
    expect(step1.dataset['done']).toBe('false');
    expect(screen.queryByTestId('onboarding-step-1-check')).toBeNull();
    // The counter cannot claim progress the runtime does not have.
    expect(screen.getByText(/0 von 3 erledigt/)).toBeTruthy();
  });

  it('OM-78/OM-79: a stored access without a runtime points at the assignment, not at connecting again', () => {
    renderCard({ cliLoggedIn: true, runtimeUp: false });

    expect(screen.getByTestId('onboarding-step-1-assign-hint')).toBeTruthy();
    expect(screen.getByText(/Zuordnung des Orchestrators/)).toBeTruthy();
    const step1 = screen.getByTestId('onboarding-step-1');
    const links = Array.from(step1.querySelectorAll('a'));
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/admin/providers');
    expect(screen.getByText(/Orchestrator zuordnen/)).toBeTruthy();
    // The "connect an access" CTAs are gone: the operator already has one.
    expect(screen.queryByText(/API-Schlüssel hinterlegen/)).toBeNull();
  });

  it('OM-78: the counter never reaches 3 von 3 while the runtime is down', () => {
    renderCard({
      llmVerified: true,
      cliLoggedIn: true,
      hasInstalledPlugin: true,
      runtimeUp: false,
    });
    expect(screen.queryByText(/3 von 3 erledigt/)).toBeNull();
    expect(screen.getByText(/1 von 3 erledigt/)).toBeTruthy();
  });

  it('OM-74: the done-copy follows the ASSIGNMENT — a CLI-backed orchestrator is not "its key was verified"', () => {
    renderCard({
      cliLoggedIn: true,
      llmVerified: true,
      runtimeUp: true,
      assignedProviderKind: 'cli',
    });
    expect(screen.getByText(/Abo-CLI angemeldet/)).toBeTruthy();
    expect(screen.queryByText(/Schlüssel wurde geprüft/)).toBeNull();
  });

  it('OM-74: an API-key assignment keeps the key copy even when a CLI is also logged in', () => {
    renderCard({
      cliLoggedIn: true,
      llmVerified: true,
      runtimeUp: true,
      assignedProviderKind: 'api',
    });
    expect(screen.getByText(/Schlüssel wurde geprüft/)).toBeTruthy();
    expect(screen.queryByText(/Abo-CLI angemeldet/)).toBeNull();
  });

  it('OM-84: names the missing embedding provider and links to its setting', () => {
    renderCard({ llmVerified: true, embeddingsOff: true });

    const note = screen.getByTestId('onboarding-embeddings-note');
    expect(note.textContent).toMatch(/Gedächtnis eingeschränkt/);
    expect(note.querySelector('a')?.getAttribute('href')).toBe(
      '/admin/embedding-provider',
    );
  });

  it('OM-84: stays silent about embeddings when a provider is published', () => {
    renderCard({ llmVerified: true, embeddingsOff: false });
    expect(screen.queryByTestId('onboarding-embeddings-note')).toBeNull();
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

  /**
   * #886 — step 3's badge said INSTALLIERT while the copy right underneath it
   * still said "Wähle oben einen Business-Case …", because the body ternary was
   * keyed on `selectedCase === null` instead of on the step's `done` signal.
   * `update-available` counts as installed (OM-27), which is why the fixture
   * mixes both states and the expected count is 2.
   */
  it('step 3 reports the installed count instead of the CTA once done', () => {
    renderCard({
      hasInstalledPlugin: true,
      plugins: [
        plugin({ id: '@omadia/channel-telegram', install_state: 'installed' }),
        plugin({
          id: '@omadia/integration-odoo',
          install_state: 'update-available',
        }),
        plugin({ id: '@omadia/notion', install_state: 'available' }),
      ],
    });

    const step3 = screen.getByTestId('onboarding-step-3');
    expect(step3.dataset['done']).toBe('true');
    expect(screen.getByText(/2 Plugins installiert/)).toBeTruthy();
    expect(screen.queryByText(/Wähle oben einen Business-Case/)).toBeNull();
  });

  it('step 3 still asks for a business case while nothing is installed', () => {
    renderCard({
      hasInstalledPlugin: false,
      plugins: [plugin({ install_state: 'available' })],
    });

    const step3 = screen.getByTestId('onboarding-step-3');
    expect(step3.dataset['done']).toBe('false');
    expect(screen.getByText(/Wähle oben einen Business-Case/)).toBeTruthy();
    expect(screen.queryByText(/Plugins? installiert/)).toBeNull();
  });
});
