import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { GitLabForgeClient } from '../../src/devplatform/forge/gitlabForgeClient.js';
import { NotImplementedError } from '../../src/devplatform/forgeClient.js';

/**
 * Epic #470 W4 §6 — the GitLab stub must REFUSE every operation loudly (never a
 * silent half-working degrade). Each method rejects with NotImplementedError.
 */
describe('GitLabForgeClient (experimental stub)', () => {
  const c = new GitLabForgeClient();

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['applyDiff', () => c.applyDiff({} as never)],
    ['getRef', () => c.getRef('o', 'r', 'main')],
    ['createPR', () => c.createPR({} as never)],
    ['getIssue', () => c.getIssue('o', 'r', 1)],
    ['listOpenIssues', () => c.listOpenIssues('o', 'r')],
    ['createIssue', () => c.createIssue({} as never)],
    ['commentIssue', () => c.commentIssue({} as never)],
  ];

  for (const [name, call] of cases) {
    it(`${name} rejects with NotImplementedError (no silent degrade)`, async () => {
      // FAIL-IF-REVERTED: a stub method that resolved instead of throwing would let
      // a GitLab job produce a broken/empty result. Every method MUST reject.
      await assert.rejects(call(), (e: unknown) => {
        assert.ok(e instanceof NotImplementedError, `${name} threw ${String(e)}`);
        assert.match((e as Error).message, /GitLab/);
        return true;
      });
    });
  }
});
