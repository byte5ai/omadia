import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { PluginCard } from '../PluginCard';
import type { Plugin } from '../../../_lib/storeTypes';

/**
 * OM-15 (#602) — the store card shows the installation-effort line BEFORE
 * install, composed by the PLATFORM from the structured `setup_profile` via
 * next-intl (so no German is baked into the manifest). The tester only learned
 * a plugin needed a Google Cloud service account and super-admin rights AFTER
 * installing; this row is what would have told them up front. Read-back tests:
 * assert the composed, localized text on screen.
 */

function plugin(over: Partial<Plugin> = {}): Plugin {
  return {
    id: '@omadia/google-workspace',
    kind: 'integration',
    name: 'Google Workspace',
    version: '1.0.0',
    latest_version: '1.0.0',
    description: 'Connect Google Workspace.',
    categories: [],
    integrations_summary: [],
    install_state: 'available',
    ...over,
  } as Plugin;
}

const REQUIREMENT = {
  en: 'Google Workspace super-admin required',
  de: 'Google-Workspace-Super-Admin erforderlich',
};

describe('<PluginCard /> — setup prerequisites row', () => {
  it('composes the German line: audience · time · requirement', () => {
    renderWithIntl(
      <PluginCard
        plugin={plugin({
          setup_profile: {
            audience: 'it_admin',
            estimated_minutes: 15,
            requirement: REQUIREMENT,
          },
        })}
      />,
      { locale: 'de' },
    );
    const row = screen.getByText(/Einrichtung durch IT-Administrator/);
    expect(row.textContent).toContain('ca. 15 Min');
    expect(row.textContent).toContain(REQUIREMENT.de);
    expect(screen.queryByText(new RegExp(REQUIREMENT.en))).toBeNull();
  });

  it('composes the English line for an English operator', () => {
    renderWithIntl(
      <PluginCard
        plugin={plugin({
          setup_profile: {
            audience: 'it_admin',
            estimated_minutes: 15,
            requirement: REQUIREMENT,
          },
        })}
      />,
      { locale: 'en' },
    );
    const row = screen.getByText(/Setup by IT administrator/);
    expect(row.textContent).toContain('~15 min');
    expect(row.textContent).toContain(REQUIREMENT.en);
  });

  it('renders only the parts the manifest declared', () => {
    renderWithIntl(
      <PluginCard plugin={plugin({ setup_profile: { estimated_minutes: 5 } })} />,
      { locale: 'de' },
    );
    expect(screen.getByText('ca. 5 Min')).toBeTruthy();
    expect(screen.queryByText(/Einrichtung durch/)).toBeNull();
  });

  it('shows no prerequisites row when there is no profile', () => {
    renderWithIntl(<PluginCard plugin={plugin()} />, { locale: 'de' });
    expect(screen.queryByText(/Min/)).toBeNull();
    expect(screen.queryByText(/Einrichtung durch/)).toBeNull();
  });
});
