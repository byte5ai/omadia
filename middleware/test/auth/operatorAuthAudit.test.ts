import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { AuditEntryInput } from '../../src/auth/adminAuditLog.js';
import {
  createOperatorAuthAccessor,
  LateBoundAdminAudit,
  scopeOperatorAuthToPlugin,
} from '../../src/auth/operatorAuthAccessor.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';

/**
 * #1329 — `ctx.operatorAuth.sessionPrincipal` / `recordAdminAction`: the
 * kernel, not the plugin, decides who the actor of an `admin_audit` row is,
 * and a plugin can only write the actions admitted for plugins.
 */
describe('#1329 — operatorAuth principal + plugin admin audit', () => {
  const signingKey = new TextEncoder().encode('operatorAuthAudit-test-signing-key-32bytes!');
  const whitelist = new EmailWhitelist('op@example.com');
  const USER_ID = '11111111-2222-4333-8444-555555555555';

  async function cookie(): Promise<string> {
    const token = await signSession(
      {
        sub: 'op@example.com',
        email: 'op@example.com',
        display_name: 'Op',
        provider: 'local',
        role: 'admin',
        uid: USER_ID,
      },
      signingKey,
    );
    return `omadia_session=${token}`;
  }

  function setup(): { rows: AuditEntryInput[]; audit: LateBoundAdminAudit; logs: string[] } {
    const rows: AuditEntryInput[] = [];
    const audit = new LateBoundAdminAudit();
    audit.attach({
      async record(entry) {
        rows.push(entry);
      },
    });
    return { rows, audit, logs: [] };
  }

  it('sessionPrincipal resolves users.id (uid) and email; null without a valid session', async () => {
    const auth = createOperatorAuthAccessor({ signingKey, whitelist });
    assert.deepEqual(await auth.sessionPrincipal?.(await cookie()), {
      userId: USER_ID,
      email: 'op@example.com',
    });
    assert.equal(await auth.sessionPrincipal?.(undefined), null);
    assert.equal(await auth.sessionPrincipal?.('omadia_session=garbage'), null);
  });

  const KEY = 'api-key:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const CHANNEL_API = '@omadia/channel-api';

  it('writes the row with the session actor and the plugin id stamped by the scope wrapper', async () => {
    const { rows, audit } = setup();
    const base = createOperatorAuthAccessor({ signingKey, whitelist, audit });
    const scoped = scopeOperatorAuthToPlugin(base, CHANNEL_API);
    const ok = await scoped.recordAdminAction?.(await cookie(), {
      action: 'api_key.delete',
      target: KEY,
      // A plugin cannot claim another plugin's identity: the stamp wins.
      before: { id: 'x', plugin: '@evil/other' },
      after: { plugin: '@evil/other' },
    });
    assert.equal(ok, true);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.actor, { id: USER_ID, email: 'op@example.com' });
    assert.deepEqual(rows[0]?.before, { id: 'x', plugin: CHANNEL_API });
    assert.deepEqual(rows[0]?.after, { plugin: CHANNEL_API });
  });

  it('refuses kernel actions, other plugins, foreign targets, big payloads and unscoped writes', async () => {
    const { rows, audit } = setup();
    const logs: string[] = [];
    const base = createOperatorAuthAccessor({ signingKey, whitelist, audit, log: (l) => logs.push(l) });
    const scoped = scopeOperatorAuthToPlugin(base, CHANNEL_API);
    const other = scopeOperatorAuthToPlugin(base, '@acme/some-plugin');
    const c = await cookie();

    assert.equal(await scoped.recordAdminAction?.(c, { action: 'user.delete', target: 'user:x' }), false);
    assert.equal(await other.recordAdminAction?.(c, { action: 'api_key.revoke', target: KEY }), false);
    assert.equal(
      await scoped.recordAdminAction?.(c, { action: 'api_key.revoke', target: 'user:11111111-2222-4333-8444-555555555555' }),
      false,
    );
    assert.equal(
      await scoped.recordAdminAction?.(c, { action: 'api_key.create', target: KEY, after: { pad: 'x'.repeat(5000) } }),
      false,
    );
    assert.equal(await base.recordAdminAction?.(c, { action: 'api_key.revoke', target: KEY }), false);
    assert.equal(await scoped.recordAdminAction?.(undefined, { action: 'api_key.revoke', target: KEY }), false);
    const unattached = scopeOperatorAuthToPlugin(
      createOperatorAuthAccessor({ signingKey, whitelist, audit: new LateBoundAdminAudit(), log: () => undefined }),
      CHANNEL_API,
    );
    assert.equal(await unattached.recordAdminAction?.(c, { action: 'api_key.revoke', target: KEY }), false);
    assert.equal(rows.length, 0);
    assert.ok(logs.some((l) => l.includes("'user.delete'")));
  });

  it('a failing audit write resolves false instead of throwing', async () => {
    const audit = new LateBoundAdminAudit();
    audit.attach({
      async record() {
        throw new Error('db down');
      },
    });
    const scoped = scopeOperatorAuthToPlugin(
      createOperatorAuthAccessor({ signingKey, whitelist, audit, log: () => undefined }),
      CHANNEL_API,
    );
    assert.equal(await scoped.recordAdminAction?.(await cookie(), { action: 'api_key.delete', target: KEY }), false);
  });

  it('a non-kernel accessor gets no audit writer when scoped', () => {
    const scoped = scopeOperatorAuthToPlugin({ async hasValidSession() { return true; } }, CHANNEL_API);
    assert.equal(scoped.recordAdminAction, undefined);
  });
});
