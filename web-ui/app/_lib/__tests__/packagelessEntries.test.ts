import { describe, expect, it } from 'vitest';

import { packagelessEntriesOf } from '../packagelessEntries';

describe('packagelessEntriesOf', () => {
  it('keeps only entries the kernel marks, sorted by id', () => {
    const rows = [
      { id: 'ui-channel', installed_version: '0.1.0', installed_at: '2026-01-02T00:00:00.000Z', status: 'package_missing', registry_status: 'active', package_missing: true },
      { id: '@omadia/memory', installed_version: '1.0.0', installed_at: '2026-01-01T00:00:00.000Z', status: 'active', registry_status: 'active', package_missing: false },
      { id: 'de.byte5.legacy', installed_version: '0.3.0', installed_at: '2026-01-03T00:00:00.000Z', status: 'package_missing', registry_status: 'errored', package_missing: true },
    ];
    expect(packagelessEntriesOf(rows)).toEqual([
      { id: 'de.byte5.legacy', version: '0.3.0', installedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'ui-channel', version: '0.1.0', installedAt: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  it('a middleware without the field reports none', () => {
    expect(packagelessEntriesOf([{ id: 'x', installed_version: '1', installed_at: '', status: 'active' }])).toEqual([]);
    expect(packagelessEntriesOf(undefined)).toEqual([]);
  });
});
