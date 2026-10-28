import { fireEvent, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { InstallButton } from '../InstallButton';

/**
 * #1481 — uninstalling a built-in used to read like uninstalling an upload:
 * the dialog said nothing about what happens at the next restart and offered
 * to delete an "uploaded package file" a built-in does not have. The dialog
 * now names the outcome the middleware reports in `built_in_uninstall`, and
 * the package checkbox is only offered for plugins that are not built-ins.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: vi.fn(),
  configureInstallJob: vi.fn(),
  getPluginGrants: vi.fn().mockResolvedValue(null),
  deleteUploadedPackage: vi.fn(),
  getInstalledPlugin: vi.fn().mockResolvedValue(null),
  installFromRegistry: vi.fn(),
  uninstallPlugin: vi.fn(),
  updateInstalledPluginConfig: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const NAME = 'Agent Discussion';

function openDialog(
  builtInUninstall?: 'persistent' | 'reinstalled_at_boot',
): void {
  const element: React.ReactElement = (
    <InstallButton
      pluginId="@omadia/plugin-discussion"
      pluginName={NAME}
      installState="installed"
      enabled
      blockingReasons={[]}
      installedVersion="0.3.0"
      {...(builtInUninstall ? { builtInUninstall } : {})}
    />
  );
  renderWithIntl(element);
  fireEvent.click(
    screen.getByRole('button', {
      name: en.store.install.uninstallAria.replace('{name}', NAME),
    }),
  );
}

/** The rich-text message without its tags, with the name filled in. */
function plain(message: string): string {
  return message.replace(/<\/?strong>/g, '').replace('{name}', NAME);
}

describe('InstalledPanel uninstall dialog (#1481)', () => {
  it('tells the operator a built-in stays uninstalled and drops the package checkbox', () => {
    openDialog('persistent');
    expect(
      screen.getByText((_, el) =>
        el?.tagName === 'P' &&
        el.textContent === plain(en.store.install.builtInUninstallPersistent),
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('warns that a boot-selected provider comes back at the next restart', () => {
    openDialog('reinstalled_at_boot');
    expect(
      screen.getByText((_, el) =>
        el?.tagName === 'P' &&
        el.textContent === plain(en.store.install.builtInUninstallReinstalled),
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('keeps the package checkbox for an uploaded plugin', () => {
    openDialog();
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });
});
