import { describe, expect, it } from 'vitest';

import { entitySystemOverlaps } from '../entitySystemOverlap';
import type { Plugin, PluginInstallState } from '../storeTypes';

/**
 * #2245 / ADR-0167 — an overlap is a system the subject declares that ANOTHER
 * INSTALLED plugin declares too. Not the subject itself (its own installed row
 * would warn about itself on its own page), and not a catalog entry that is
 * merely available.
 */

function plugin(
  id: string,
  systems: string[] | undefined,
  install_state: PluginInstallState = 'installed',
): Pick<Plugin, 'id' | 'name' | 'install_state' | 'permissions_summary'> {
  return {
    id,
    name: `Name of ${id}`,
    install_state,
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      ...(systems ? { graph_entity_systems: systems } : {}),
    },
  };
}

describe('entitySystemOverlaps', () => {
  it('names the installed plugins that already declare a system', () => {
    const subject = plugin('@x/second-odoo', ['odoo', 'crm'], 'available');
    const catalog = [
      plugin('@omadia/integration-odoo', ['odoo']),
      plugin('@x/b', ['odoo'], 'update-available'),
      plugin('@x/crm', ['crm'], 'available'),
      subject,
    ];
    expect(entitySystemOverlaps(subject, catalog)).toEqual([
      {
        system: 'odoo',
        pluginNames: ['Name of @omadia/integration-odoo', 'Name of @x/b'],
      },
    ]);
  });

  it('never counts the subject itself', () => {
    const subject = plugin('@omadia/integration-odoo', ['odoo']);
    expect(entitySystemOverlaps(subject, [subject])).toEqual([]);
  });

  it('returns nothing when the subject declares no system', () => {
    const catalog = [plugin('@omadia/integration-odoo', ['odoo'])];
    expect(entitySystemOverlaps(plugin('@x/a', undefined), catalog)).toEqual([]);
    expect(entitySystemOverlaps(plugin('@x/a', []), catalog)).toEqual([]);
  });

  it('tolerates catalog rows from an older middleware without the field', () => {
    const subject = plugin('@x/a', ['odoo'], 'available');
    expect(
      entitySystemOverlaps(subject, [plugin('@x/old', undefined)]),
    ).toEqual([]);
  });
});
