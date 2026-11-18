import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createTeamsSsoAudienceSource } from '../../src/platform/teamsSsoAudiences.js';
import type {
  InstalledAgent,
  InstalledRegistry,
} from '../../src/plugins/installedRegistry.js';

/**
 * #1620 — "audience = the app id of an INSTALLED Teams bot". The kernel reads
 * the bots exactly where channel-teams reads them: `teams_bots[]` plus the
 * legacy scalar bot from its config chain (own config, then the Microsoft 365
 * integration it depends on).
 */

const CHANNEL = '@omadia/channel-teams';
const M365 = '@omadia/integration-microsoft365';

function registry(entries: Record<string, Partial<InstalledAgent>>): InstalledRegistry {
  const all = Object.entries(entries).map(
    ([id, e]) =>
      ({
        id,
        installed_version: '1.0.0',
        installed_at: '2026-11-01T00:00:00Z',
        status: 'active',
        config: {},
        ...e,
      }) as InstalledAgent,
  );
  return {
    list: () => all,
    get: (id: string) => all.find((e) => e.id === id),
    has: (id: string) => all.some((e) => e.id === id),
  } as unknown as InstalledRegistry;
}

function source(reg: InstalledRegistry | undefined) {
  return createTeamsSsoAudienceSource({
    registry: () => reg,
    configChain: (id) => (id === CHANNEL ? [CHANNEL, M365] : [id]),
  });
}

describe('#1620 — Teams SSO audiences from the installed channel-teams', () => {
  it('no channel-teams installed → no audiences', () => {
    assert.deepEqual(source(registry({}))(), []);
    assert.deepEqual(source(undefined)(), []);
  });

  it('an inactive or errored channel-teams → no audiences', () => {
    for (const status of ['inactive', 'errored'] as const) {
      const reg = registry({
        [CHANNEL]: {
          status,
          config: { microsoft_app_id: 'app-1', microsoft_tenant_id: 'tenant-1' },
        },
      });
      assert.deepEqual(source(reg)(), []);
    }
  });

  it('the legacy scalar bot resolves through the Microsoft 365 integration', () => {
    const reg = registry({
      [CHANNEL]: { config: {} },
      [M365]: { config: { microsoft_app_id: 'app-1', microsoft_tenant_id: 'tenant-1' } },
    });
    assert.deepEqual(source(reg)(), [{ appId: 'app-1', tenantId: 'tenant-1' }]);
  });

  it('teams_bots[] (JSON string form) merges with the legacy bot, deduplicated', () => {
    const reg = registry({
      [CHANNEL]: {
        config: {
          teams_bots: JSON.stringify([
            { botSlug: 'hr', appId: 'app-2', tenantId: 'tenant-1' },
            { botSlug: 'default', appId: 'APP-1', tenantId: 'tenant-1' },
            { botSlug: 'broken', appId: '', tenantId: 'tenant-1' },
          ]),
        },
      },
      [M365]: { config: { microsoft_app_id: 'app-1', microsoft_tenant_id: 'tenant-1' } },
    });
    assert.deepEqual(source(reg)(), [
      { appId: 'app-2', tenantId: 'tenant-1' },
      { appId: 'APP-1', tenantId: 'tenant-1' },
    ]);
  });

  it('teams_bots[] in array form is read too', () => {
    const reg = registry({
      [CHANNEL]: {
        config: { teams_bots: [{ botSlug: 'hr', appId: 'app-2', tenantId: 'tenant-2' }] },
      },
    });
    assert.deepEqual(source(reg)(), [{ appId: 'app-2', tenantId: 'tenant-2' }]);
  });

  it('an unreadable teams_bots value contributes nothing, the legacy bot still counts', () => {
    const reg = registry({
      [CHANNEL]: {
        config: {
          teams_bots: '{not json',
          microsoft_app_id: 'app-1',
          microsoft_tenant_id: 'tenant-1',
        },
      },
    });
    assert.deepEqual(source(reg)(), [{ appId: 'app-1', tenantId: 'tenant-1' }]);
  });

  it('a half-set scalar pair describes no bot', () => {
    const reg = registry({ [CHANNEL]: { config: { microsoft_app_id: 'app-1' } } });
    assert.deepEqual(source(reg)(), []);
  });
});
