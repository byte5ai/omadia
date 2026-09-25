import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { SubscriptionClisPanel } from '../SubscriptionClisPanel';
import type { CliBackendStatus } from '../../../../_lib/api';

/**
 * OM-11 + OM-22.
 *
 * OM-11: the customer clicked "Anmelden →" and landed on this panel showing
 * "NICHT GEFUNDEN – In dieser Umgebung nicht installiert", with no login button
 * and no way to get the CLI onto the server. The install instructions DID exist
 * — but behind `canConnect = b.installed && …`, i.e. hidden precisely when
 * `!installed`, which is exactly when they are needed.
 *
 * OM-22: "Erneut prüfen" appeared to do nothing. `generatedAt` was already on
 * the wire and had zero render sites.
 */

const {
  mockGetCliBackends,
  mockStartCliInstall,
  mockGetCliInstallStatus,
  mockStartCliLogin,
  mockGetCliLoginStatus,
  mockSubmitCliLoginCode,
} = vi.hoisted(() => ({
  mockGetCliBackends: vi.fn(),
  mockStartCliInstall: vi.fn(),
  mockGetCliInstallStatus: vi.fn(),
  mockStartCliLogin: vi.fn(),
  mockGetCliLoginStatus: vi.fn(),
  mockSubmitCliLoginCode: vi.fn(),
}));

const CLI_TOOLS_DIR = '/var/lib/omadia/cli-tools';

vi.mock('../../../../_lib/api', () => ({
  getCliBackends: mockGetCliBackends,
  startCliLogin: mockStartCliLogin,
  submitCliLoginCode: mockSubmitCliLoginCode,
  getCliLoginStatus: mockGetCliLoginStatus,
  cancelCliLogin: vi.fn(),
  cliLogout: vi.fn(),
  startCliInstall: mockStartCliInstall,
  getCliInstallStatus: mockGetCliInstallStatus,
  // The embedded TurnBudgetField (OM-104) loads the orchestrator config. Let it
  // load cleanly, so its own failed-load disclosure (#1077) never competes
  // with the install box's "Details for support" in these assertions.
  getInstalledPlugin: vi.fn().mockResolvedValue({ config: {} }),
  updateInstalledPluginConfig: vi.fn(),
  ApiError: class MockApiError extends Error {},
}));

function backend(over: Partial<CliBackendStatus> = {}): CliBackendStatus {
  return {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    installed: true,
    loggedIn: 'no',
    billing: 'subscription',
    detail: 'Installed but not logged in.',
    ...over,
  } as CliBackendStatus;
}

describe('<SubscriptionClisPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('OM-11: an uninstalled CLI shows NO connect button but DOES show install help', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [
        backend({
          installed: false,
          detail: 'claude is not installed in this environment.',
        }),
      ],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    // Wait for the READY render first: a bare `waitFor(null)` is already
    // satisfied by the loading state and made this test flake under load.
    // The way OUT of the dead end must be visible …
    expect(await screen.findByText(/CLI installieren/)).toBeTruthy();

    // … and no in-app login is possible without the binary.
    expect(screen.queryByRole('button', { name: /Jetzt anmelden|Verbinden/i })).toBeNull();
    expect(
      screen.getByText(
        new RegExp(
          `npm install -g @anthropic-ai/claude-code --prefix ${CLI_TOOLS_DIR}`,
        ),
      ),
    ).toBeTruthy();
  });

  it('OM-22: renders the snapshot timestamp so a re-check is observable', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: false })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.parse('2026-08-03T09:41:07Z'),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    const el = await screen.findByTestId('cli-last-checked');
    expect(el.textContent).toMatch(/Zuletzt geprüft/);
    // A real time, not an empty interpolation.
    expect(el.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('an installed CLI still offers the in-app login', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: true, loggedIn: 'no' })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    // The connect box renders; the install steps stay collapsed behind the
    // existing <details>, exactly as before. Wait for the READY render (the
    // manual-install steps) before asserting — the earlier `waitFor(null)` was
    // satisfied by the loading state and made this test flake under load.
    expect(
      await screen.findByText(
        new RegExp(
          `npm install -g @anthropic-ai/claude-code --prefix ${CLI_TOOLS_DIR}`,
        ),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/CLI installieren/)).toBeNull();
  });

  it('an uninstalled installable CLI offers the in-app install button (manual steps collapsed)', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: false, installable: true })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    const button = await screen.findByRole('button', { name: /Jetzt installieren/ });
    expect(button).toBeTruthy();
    // The terminal path stays available, one click away.
    expect(screen.getByText(/Lieber manuell installieren\?/)).toBeTruthy();
  });

  it('clicking install triggers the backend job and shows progress', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: false, installable: true })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });
    mockStartCliInstall.mockResolvedValue({ status: 'started' });
    mockGetCliInstallStatus.mockResolvedValue({ cliId: 'claude', status: 'running' });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    const button = await screen.findByRole('button', { name: /Jetzt installieren/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockStartCliInstall).toHaveBeenCalledWith('claude');
    });
    expect(await screen.findByTestId('cli-install-running')).toBeTruthy();
  });

  /**
   * #882 — the failure the PATH bug actually produces: npm is never found, so
   * it exits with no output at all and the old UI showed "Installation failed."
   * above an empty <pre>. The status now carries a code, and the box renders
   * through the shared <ErrorHelp>, so the operator gets the catalogued
   * explanation instead of a blank log.
   *
   * Real timers on purpose: the install poll runs on a 3s setInterval, and
   * vitest's fake timers deadlock against testing-library's waitFor (which
   * needs a working timer to poll the DOM). The extended timeout below covers
   * one poll tick.
   */
  it('a failed install with cli_install.no_output renders catalogued help copy', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: false, installable: true })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });
    mockStartCliInstall.mockResolvedValue({ status: 'started' });
    mockGetCliInstallStatus.mockResolvedValue({
      cliId: 'claude',
      status: 'failed',
      code: 'cli_install.no_output',
      error: 'spawn npm ENOENT',
      logTail: '',
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />);

    const button = await screen.findByRole('button', { name: /install now/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockStartCliInstall).toHaveBeenCalledWith('claude');
    });

    // The catalogued `what` line — proof it went through <ErrorHelp> rather
    // than the old raw-log-tail block.
    expect(
      await screen.findByText(
        'npm produced no output at all, which means the npm command itself could not be run on the server.',
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    // …and the catalogued `next` line, which names the actual way out.
    expect(
      screen.getByText(
        "Install the CLI manually with the shown command, or make sure Node and npm are on the server's PATH.",
      ),
    ).toBeTruthy();
    // The server's English string is never the headline; it sits in the
    // redacted support disclosure.
    expect(screen.getByText('Details for support')).toBeTruthy();
  }, 20_000);

  /**
   * OM-48 (#887) — both rows can legitimately share the same install-state
   * badge, so the billing badge copy must self-identify as billing data
   * instead of reading like a second, contradictory detection result.
   */
  it('OM-48: prefixes billing badges so they cannot be read as install-state badges', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [
        backend({
          id: 'claude',
          installed: false,
          billing: 'needs-verification',
          detail: 'claude is not installed in this environment.',
        }),
        backend({
          id: 'codex',
          label: 'Codex',
          bin: 'codex',
          installed: false,
          billing: 'subscription',
          detail: 'codex is not installed in this environment.',
        }),
      ],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    expect(await screen.findAllByText(/^nicht gefunden$/i)).toHaveLength(2);

    await waitFor(() => {
      expect(screen.getByText(/^Abrechnung: noch zu prüfen$/)).toBeTruthy();
      expect(screen.getByText(/^Abrechnung: Abo$/)).toBeTruthy();
    });
  });

  /**
   * OM-73 (#995) + #1084 — with `codeEntry: false` (a CLI that printed a URL
   * but no paste prompt) the panel polls the login status until the row is
   * connected. #1084: the classification can be wrong — the image's 2.1.187
   * CLI waited on a pasted code while the UI showed only "no code to paste" +
   * Cancel — so the polling view ALWAYS carries a secondary code field too.
   *
   * Real timers on purpose (see the install-poll test above): the status poll
   * runs on a 3s cadence and vitest's fake timers deadlock against waitFor.
   */
  it('OM-73: a browser-callback login shows the fallback code field and reaches connected via polling', async () => {
    mockGetCliBackends
      .mockResolvedValueOnce({
        backends: [backend({ installed: true, loggedIn: 'no' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      })
      // After the poll reports `authorized`, onChanged re-loads: now logged in.
      .mockResolvedValue({
        backends: [backend({ installed: true, loggedIn: 'yes', account: 'me@firm.de' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      });
    mockStartCliLogin.mockResolvedValue({
      sessionId: 'login-1',
      verificationUrl: 'https://claude.com/oauth/authorize?x=1',
      codeEntry: false,
      status: 'pending',
    });
    mockGetCliLoginStatus.mockResolvedValue({ status: 'authorized', account: 'me@firm.de' });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    const connect = await screen.findByRole('button', { name: /Abo verbinden/i });
    fireEvent.click(connect);

    // The callback-wait copy appears, and so does the secondary code field.
    await screen.findByText(/sobald die Anmeldung abgeschlossen ist/i);
    expect(screen.getByText(/stattdessen einen Code/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/Login-Code einfügen/i)).toBeTruthy();
    expect(mockStartCliLogin).toHaveBeenCalledWith('claude');

    // One poll tick later the row is CONNECTED — no code was ever pasted.
    await waitFor(
      () => {
        expect(mockGetCliLoginStatus).toHaveBeenCalledWith('claude');
        expect(screen.getByText(/Angemeldet als me@firm\.de/)).toBeTruthy();
      },
      { timeout: 6000 },
    );
    expect(screen.queryByText(/sobald die Anmeldung abgeschlossen ist/i)).toBeNull();
    expect(mockSubmitCliLoginCode).not.toHaveBeenCalled();
  }, 10000);

  it('#1084: a code pasted into the polling fallback field is submitted to the live session', async () => {
    mockGetCliBackends
      .mockResolvedValueOnce({
        backends: [backend({ installed: true, loggedIn: 'no' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      })
      .mockResolvedValue({
        backends: [backend({ installed: true, loggedIn: 'yes', account: 'me@firm.de' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      });
    mockStartCliLogin.mockResolvedValue({
      sessionId: 'login-1',
      verificationUrl: 'https://claude.com/oauth/authorize?x=1',
      codeEntry: false,
      status: 'pending',
    });
    mockGetCliLoginStatus.mockResolvedValue({ status: 'pending' });
    mockSubmitCliLoginCode.mockResolvedValue({ status: 'authorized', account: 'me@firm.de' });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    fireEvent.click(await screen.findByRole('button', { name: /Abo verbinden/i }));
    const input = await screen.findByPlaceholderText(/Login-Code einfügen/i);
    fireEvent.change(input, { target: { value: 'the-code' } });
    fireEvent.click(screen.getByRole('button', { name: /Code senden/i }));

    await waitFor(() => {
      expect(mockSubmitCliLoginCode).toHaveBeenCalledWith('claude', 'login-1', 'the-code');
    });
    expect(await screen.findByText(/Angemeldet als me@firm\.de/)).toBeTruthy();
  }, 10000);

  it('#1084: a poll that ends (session gone) shows Retry, not a dead code field', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: true, loggedIn: 'no' })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });
    mockStartCliLogin.mockResolvedValue({
      sessionId: 'login-3',
      verificationUrl: 'https://claude.com/oauth/authorize?x=3',
      codeEntry: false,
      status: 'pending',
    });
    // The server no longer has the session (reaped at lifetime / replaced).
    mockGetCliLoginStatus.mockResolvedValue({ status: 'idle' });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    fireEvent.click(await screen.findByRole('button', { name: /Abo verbinden/i }));
    await screen.findByText(/sobald die Anmeldung abgeschlossen ist/i);

    expect(
      await screen.findByText(/nicht rechtzeitig abgeschlossen/i, {}, { timeout: 6000 }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Erneut versuchen/i })).toBeTruthy();
    // The session is gone server-side, so a code field here could only fail.
    expect(screen.queryByPlaceholderText(/Login-Code einfügen/i)).toBeNull();
    expect(mockSubmitCliLoginCode).not.toHaveBeenCalled();
  }, 10000);

  /** #1084 — the image's 2.1.187 CLI: a paste prompt ⇒ `codeEntry: true`. */
  function startsWithPastePrompt(sessionId: string): void {
    mockStartCliLogin.mockResolvedValue({
      sessionId,
      verificationUrl: `https://claude.com/cai/oauth/authorize?code=true&s=${sessionId}`,
      codeEntry: true,
      status: 'pending',
    });
  }

  it('#1084: codeEntry=true shows the code field at once; a wrong code keeps it, the right retry connects', async () => {
    mockGetCliBackends
      .mockResolvedValueOnce({
        backends: [backend({ installed: true, loggedIn: 'no' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      })
      .mockResolvedValue({
        backends: [backend({ installed: true, loggedIn: 'yes', account: 'me@firm.de' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      });
    startsWithPastePrompt('login-4');
    mockGetCliLoginStatus.mockResolvedValue({ status: 'pending' });
    // Keyed on the code (not a Once-queue) so a failure here cannot leak a
    // queued result into the next test.
    mockSubmitCliLoginCode.mockImplementation(async (_id: string, _sid: string, code: string) =>
      code === 'good'
        ? { status: 'authorized', account: 'me@firm.de' }
        : { status: 'invalid', error: 'Invalid code. Copy the full code and try again.' },
    );

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    fireEvent.click(await screen.findByRole('button', { name: /Abo verbinden/i }));
    // The main field, not the callback wait.
    const input = await screen.findByPlaceholderText(/Login-Code einfügen/i);
    expect(screen.getByText(/Wird nach der Bestätigung ein Code angezeigt/i)).toBeTruthy();
    expect(screen.queryByText(/sobald die Anmeldung abgeschlossen ist/i)).toBeNull();

    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /Code senden/i }));
    expect(await screen.findByText(/Invalid code/)).toBeTruthy();
    // The server session is still pending: the field stays, no Retry.
    expect(screen.getByPlaceholderText(/Login-Code einfügen/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Erneut versuchen/i })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/Login-Code einfügen/i), {
      target: { value: 'good' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Code senden/i }));
    expect(await screen.findByText(/Angemeldet als me@firm\.de/)).toBeTruthy();
    expect(mockSubmitCliLoginCode).toHaveBeenLastCalledWith('claude', 'login-4', 'good');
  }, 10000);

  it('#1084: after a wrong code the status poll resumes, so a callback that completes still connects', async () => {
    mockGetCliBackends
      .mockResolvedValueOnce({
        backends: [backend({ installed: true, loggedIn: 'no' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      })
      .mockResolvedValue({
        backends: [backend({ installed: true, loggedIn: 'yes', account: 'me@firm.de' })],
        cliToolsDir: CLI_TOOLS_DIR,
        generatedAt: Date.now(),
      });
    startsWithPastePrompt('login-5');
    // Any poll tick sees the finished login. The submit's result stops the
    // first loop before its first 3s tick, so only a RESUMED loop can see it.
    mockGetCliLoginStatus.mockResolvedValue({ status: 'authorized' });
    mockSubmitCliLoginCode.mockResolvedValue({ status: 'invalid', error: 'Invalid code.' });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    fireEvent.click(await screen.findByRole('button', { name: /Abo verbinden/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Login-Code einfügen/i), {
      target: { value: 'bad' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Code senden/i }));
    await screen.findByText(/Invalid code/);

    expect(
      await screen.findByText(/Angemeldet als me@firm\.de/, {}, { timeout: 6000 }),
    ).toBeTruthy();
    expect(mockSubmitCliLoginCode).toHaveBeenCalledTimes(1);
  }, 10000);

  it('#1084: a submit that finds the session gone shows Retry, not a dead code field', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: true, loggedIn: 'no' })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });
    startsWithPastePrompt('login-6');
    mockGetCliLoginStatus.mockResolvedValue({ status: 'pending' });
    mockSubmitCliLoginCode.mockResolvedValue({
      status: 'expired',
      error: 'No active login session. Start again.',
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    fireEvent.click(await screen.findByRole('button', { name: /Abo verbinden/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Login-Code einfügen/i), {
      target: { value: 'late' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Code senden/i }));

    expect(await screen.findByText(/No active login session/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Erneut versuchen/i })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Login-Code einfügen/i)).toBeNull();
  }, 10000);

  it('OM-73: cancelling the callback login stops the status poll', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: true, loggedIn: 'no' })],
      cliToolsDir: CLI_TOOLS_DIR,
      generatedAt: Date.now(),
    });
    mockStartCliLogin.mockResolvedValue({
      sessionId: 'login-2',
      verificationUrl: 'https://claude.com/oauth/authorize?x=2',
      codeEntry: false,
      status: 'pending',
    });
    mockGetCliLoginStatus.mockResolvedValue({ status: 'pending' });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    fireEvent.click(await screen.findByRole('button', { name: /Abo verbinden/i }));
    await screen.findByText(/sobald die Anmeldung abgeschlossen ist/i);

    fireEvent.click(screen.getByRole('button', { name: /^Abbrechen$/ }));
    // Back to the idle row immediately …
    expect(await screen.findByRole('button', { name: /Abo verbinden/i })).toBeTruthy();

    // … and the loop must not fire a single status request after the cancel,
    // not even the tick that was already scheduled.
    await new Promise((r) => setTimeout(r, 3500));
    expect(mockGetCliLoginStatus).not.toHaveBeenCalled();
  }, 10000);
});
