import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { PluginVerdictBadge, type PluginVerdictSeverity } from '../PluginVerdictBadge';

describe('<PluginVerdictBadge />', () => {
  const cases: [PluginVerdictSeverity, RegExp][] = [
    ['no_signals', /No known risk signals/i],
    ['flagged', /Flagged — review recommended/i],
    ['high_risk', /High risk — review required/i],
    ['scan_failed', /Scan failed/i],
    ['too_large_to_scan', /Too large to scan/i],
    ['pending', /Scanning…/i],
    ['not_yet_scanned', /Not yet scanned/i],
  ];

  it.each(cases)('renders the %s severity label', (severity, label) => {
    renderWithIntl(<PluginVerdictBadge severity={severity} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
