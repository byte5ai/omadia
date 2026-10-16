import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { AuditEntryInput } from '../../src/auth/adminAuditLog.js';
import {
  createLoginFailureReporter,
  LOGIN_FAILURE_MAX_TRACKED,
  LOGIN_FAILURE_WINDOW_MS,
} from '../../src/auth/loginFailureAudit.js';

function harness() {
  let t = 1_000_000;
  const rows: AuditEntryInput[] = [];
  const lines: string[] = [];
  const reporter = createLoginFailureReporter({
    audit: {
      record: async (entry) => {
        rows.push(entry);
      },
    },
    log: (m) => lines.push(m),
    // Only admin@example.com exists.
    resolveAccount: async (_provider, account) =>
      account === 'admin@example.com' ? { id: USER_ID, email: 'admin@example.com' } : undefined,
    now: () => t,
  });
  return {
    rows,
    lines,
    reporter,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const USER_ID = '7c6b5a49-3827-4615-a504-f3e2d1c0b9a8';
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const failure = {
  providerId: 'local',
  accountId: 'Admin@Example.com',
  clientKey: '192.0.2.10',
  code: 'invalid_credentials',
};

describe('failed sign-in audit (#1315)', () => {
  it('writes one row and one log line per (account, client) per minute — never the password', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.reporter.report(failure);
    await flush();
    assert.equal(h.rows.length, 1);
    assert.equal(h.lines.length, 1);
    assert.deepEqual(h.rows[0], {
      actor: {},
      action: 'auth.login_failed',
      target: 'login-client:192.0.2.10',
      after: {
        provider: 'local',
        account: 'admin@example.com',
        account_user_id: USER_ID,
        reason: 'invalid_credentials',
        window_s: 60,
      },
    });
    assert.match(h.lines[0]!, new RegExp(`login failed \\(invalid_credentials\\).*client=192\\.0\\.2\\.10.*user=${USER_ID}`));

    h.advance(LOGIN_FAILURE_WINDOW_MS);
    h.reporter.report(failure);
    await flush();
    assert.equal(h.rows.length, 2, 'the next minute opens a new row');
  });

  it('keeps clients and accounts apart', async () => {
    const h = harness();
    h.reporter.report(failure);
    h.reporter.report({ ...failure, clientKey: 'device:abc' });
    h.reporter.report({ ...failure, accountId: 'other@example.com' });
    await flush();
    assert.equal(h.rows.length, 3);
  });

  it('never records the submitted text — a password in the email field included', async () => {
    const h = harness();
    // Address-shaped passwords pass the address check; they still name no user.
    for (const accountId of ['hunter2-my-password', 'Summer@2024', 'p@ssw0rd']) {
      h.reporter.report({ ...failure, accountId });
    }
    await flush();
    assert.equal(h.rows.length, 3);
    for (const row of h.rows) {
      const after = row.after as { account: unknown; account_user_id: unknown };
      assert.equal(after.account, null);
      assert.equal(after.account_user_id, null);
    }
    const everything = JSON.stringify(h.rows) + h.lines.join('\n');
    assert.doesNotMatch(everything, /hunter2|summer@2024|p@ssw0rd/i);
  });

  it('folds a spray past the tracking cap into one overflow row per minute', async () => {
    const h = harness();
    for (let i = 0; i < LOGIN_FAILURE_MAX_TRACKED + 50; i += 1) {
      h.reporter.report({ ...failure, clientKey: `198.51.100.${String(i)}` });
    }
    await flush();
    assert.equal(h.rows.length, LOGIN_FAILURE_MAX_TRACKED + 1);
    assert.equal(h.rows.filter((r) => r.target === 'login:failures-overflow').length, 1);
  });
});
