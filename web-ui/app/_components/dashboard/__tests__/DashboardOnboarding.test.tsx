import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { RuntimeReadiness } from '../../../_lib/runtimeReadiness';
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
    runtimeState: RuntimeReadiness;
    assignedProviderKind: 'cli' | 'oauth' | 'api' | null;
    assignedProviderStatus: 'no_key' | 'unverified' | 'verified' | 'invalid' | null;
    assignedProviderLabel: string | null;
    embeddingsOff: boolean;
    hasInstalledPlugin: boolean;
  }> = {},
) {
  // OM-78 (#1001) — a stored access implies the runtime is up in the default
  // fixture, so the pre-existing step-model tests keep describing the happy
  // path. The OM-78 / #1088 tests below set `runtimeState` explicitly.
  // Likewise the default assignment mirrors the access flags: CLI login → CLI
  // assignment, verified key → verified API assignment.
  const runtimeState: RuntimeReadiness =
    over.runtimeState ?? (over.llmVerified || over.cliLoggedIn ? 'up' : 'down');
  return renderWithIntl(
    <DashboardOnboarding
      plugins={[]}
      llmVerified={false}
      cliLoggedIn={false}
      assignedProviderKind={over.cliLoggedIn ? 'cli' : 'api'}
      assignedProviderStatus={over.llmVerified ? 'verified' : 'no_key'}
      assignedProviderLabel="Anthropic"
      embeddingsOff={false}
      hasInstalledPlugin={false}
      {...over}
      runtimeState={runtimeState}
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
    renderCard({ llmVerified: true, runtimeState: 'down' });

    const step1 = screen.getByTestId('onboarding-step-1');
    expect(step1.dataset['done']).toBe('false');
    expect(screen.queryByTestId('onboarding-step-1-check')).toBeNull();
    // The counter cannot claim progress the runtime does not have.
    expect(screen.getByText(/0 von 3 erledigt/)).toBeTruthy();
  });

  it('OM-78 / #994: a stored access without a runtime points at the assignment, not at connecting again', () => {
    renderCard({ cliLoggedIn: true, runtimeState: 'down' });

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
      runtimeState: 'down',
    });
    expect(screen.queryByText(/3 von 3 erledigt/)).toBeNull();
    expect(screen.getByText(/1 von 3 erledigt/)).toBeTruthy();
  });

  /**
   * #1088 — with the middleware container stopped, step 1 used to show a green
   * checkmark and „Die Agent-Runtime läuft." while the health tile on the same
   * page read „Nicht erreichbar". An unreachable backend must never tick a
   * setup step, and must not borrow either of the two copies that make claims
   * about an access it cannot see.
   */
  describe('#1088 — an unreachable middleware', () => {
    it('leaves step 1 open and never claims the runtime is running', () => {
      renderCard({ llmVerified: true, runtimeState: 'unreachable' });

      const step1 = screen.getByTestId('onboarding-step-1');
      expect(step1.dataset['done']).toBe('false');
      expect(screen.queryByTestId('onboarding-step-1-check')).toBeNull();
      expect(screen.queryByText(/Die Agent-Runtime läuft/)).toBeNull();
      expect(screen.queryByTestId('onboarding-step-1-done-copy')).toBeNull();
    });

    it('says the status could not be checked and links to the status page', () => {
      renderCard({ llmVerified: true, runtimeState: 'unreachable' });

      const copy = screen.getByTestId('onboarding-step-1-unreachable');
      expect(copy.textContent).toMatch(/nicht geantwortet/);
      // The page only knows that THIS route gave nothing back — a live
      // middleware can answer 500 from one handler — so the copy hedges
      // instead of declaring the container dead. Otherwise it would
      // contradict the "Middleware · Verbunden" health tile beside it.
      expect(copy.textContent).toMatch(/Möglicherweise/);
      const step1 = screen.getByTestId('onboarding-step-1');
      const links = Array.from(step1.querySelectorAll('a'));
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute('href')).toBe('/admin/update');
    });

    it('does not send the operator to the assignment — that diagnosis needs an answer', () => {
      renderCard({ cliLoggedIn: true, runtimeState: 'unreachable' });

      expect(screen.queryByTestId('onboarding-step-1-assign-hint')).toBeNull();
      expect(screen.queryByText(/Zuordnung des Orchestrators/)).toBeNull();
      expect(screen.queryByText(/API-Schlüssel hinterlegen/)).toBeNull();
    });

    it('does not let the counter climb', () => {
      renderCard({
        llmVerified: true,
        cliLoggedIn: true,
        hasInstalledPlugin: true,
        runtimeState: 'unreachable',
      });
      expect(screen.getByText(/1 von 3 erledigt/)).toBeTruthy();
    });
  });

  it('OM-74: the done-copy follows the ASSIGNMENT — a CLI-backed orchestrator is not "its key was verified"', () => {
    renderCard({
      cliLoggedIn: true,
      llmVerified: true,
      runtimeState: 'up',
      assignedProviderKind: 'cli',
    });
    expect(screen.getByText(/Abo-CLI angemeldet/)).toBeTruthy();
    expect(screen.queryByText(/Schlüssel wurde geprüft/)).toBeNull();
  });

  it('OM-74: a VERIFIED API-key assignment keeps the key copy even when a CLI is also logged in', () => {
    renderCard({
      cliLoggedIn: true,
      llmVerified: true,
      runtimeState: 'up',
      assignedProviderKind: 'api',
      assignedProviderStatus: 'verified',
    });
    expect(screen.getByText(/Schlüssel wurde geprüft/)).toBeTruthy();
    expect(screen.queryByText(/Abo-CLI angemeldet/)).toBeNull();
  });

  it('OM-74: an UNVERIFIED key that the runtime happens to run on is not called "geprüft"', () => {
    renderCard({
      runtimeState: 'up',
      assignedProviderKind: 'api',
      assignedProviderStatus: 'unverified',
      assignedProviderLabel: 'Anthropic',
    });
    const copy = screen.getByTestId('onboarding-step-1-done-copy');
    expect(copy.textContent).toMatch(/Agent-Runtime läuft über Anthropic/);
    expect(copy.textContent).not.toMatch(/geprüft/);
  });

  it('OM-74: a rejected (invalid) key is not called "geprüft" either', () => {
    renderCard({
      runtimeState: 'up',
      assignedProviderKind: 'api',
      assignedProviderStatus: 'invalid',
      assignedProviderLabel: 'OpenAI',
    });
    const copy = screen.getByTestId('onboarding-step-1-done-copy');
    expect(copy.textContent).toMatch(/läuft über OpenAI/);
    expect(copy.textContent).not.toMatch(/geprüft/);
  });

  it('OM-74: an OAuth subscription assignment gets its own neutral sentence', () => {
    renderCard({
      runtimeState: 'up',
      assignedProviderKind: 'oauth',
      assignedProviderStatus: 'verified',
      assignedProviderLabel: 'ChatGPT',
    });
    const copy = screen.getByTestId('onboarding-step-1-done-copy');
    expect(copy.textContent).toMatch(/Abo ist verbunden/);
    expect(copy.textContent).not.toMatch(/geprüft/);
    expect(copy.textContent).not.toMatch(/Abo-CLI/);
  });

  it('OM-74: an unknown assignment (providers call failed) falls back to the label-less sentence', () => {
    renderCard({
      runtimeState: 'up',
      assignedProviderKind: null,
      assignedProviderStatus: null,
      assignedProviderLabel: null,
    });
    const copy = screen.getByTestId('onboarding-step-1-done-copy');
    expect(copy.textContent).toMatch(/Die Agent-Runtime läuft\./);
    expect(copy.textContent).not.toMatch(/geprüft/);
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

  /**
   * #1089 — the badge and the sentence must agree on WHICH plugins count. The
   * step ticks on the operator's installs, so the copy counts those too;
   * counting all of them made a ticked step 3 read "17 Plugins installiert" on
   * a deployment where the operator had installed exactly one.
   */
  it('step 3 counts the operator installs, not the boot auto-installs', () => {
    renderCard({
      hasInstalledPlugin: true,
      plugins: [
        plugin({ id: '@omadia/memory', install_origin: 'bundled' }),
        plugin({ id: '@omadia/orchestrator', install_origin: 'bundled' }),
        plugin({ id: '@acme/crm', install_origin: 'operator' }),
      ],
    });

    expect(screen.getByText(/1 Plugin installiert/)).toBeTruthy();
    expect(screen.queryByText(/3 Plugins installiert/)).toBeNull();
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

/**
 * #1090 / defect 3 — one done-label sits next to all three steps, and it read
 * "Installiert". Connecting an LLM and picking a business case install
 * nothing, so two thirds of the card claimed something that never happened.
 * Pinned on step 1, the step furthest from anything installable.
 */
describe('<DashboardOnboarding /> — #1090 done-label', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetOnboardingStores();
  });

  afterEach(() => {
    cleanup();
  });

  it('marks a satisfied LLM step done without claiming an install', () => {
    renderCard({ llmVerified: true });

    const step1 = screen.getByTestId('onboarding-step-1');
    expect(step1.dataset['done']).toBe('true');
    expect(step1.textContent).toContain('Erledigt');
    expect(step1.textContent).not.toContain('Installiert');
  });
});
