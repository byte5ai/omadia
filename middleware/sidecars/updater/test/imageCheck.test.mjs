import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { checkImages } from '../src/imageCheck.mjs';

/**
 * The read-only dry run of step 2. The properties that matter are all about
 * NOT lying to the operator: an unreachable registry is not a missing tag, an
 * unresolvable service is not a silent pass, and nothing here may mutate.
 */

const CONFIG = {
  services: ['middleware', 'web-ui'],
  selfService: 'updater',
};

function engineFor(repos) {
  return {
    kind: 'fly',
    canPersistPin: false,
    async resolveTarget(service) {
      const repo = repos[service];
      if (repo === undefined) throw new Error(`no machine for "${service}"`);
      return {
        service,
        currentImage: `${repo}:v0.136.2`,
        repo,
        handle: {},
      };
    },
    async preflight() { throw new Error('preflight must not be called'); },
    async pin() { return null; },
    async restorePin() {},
    pinDescription() { return null; },
    async replace() { throw new Error('replace must not be called'); },
  };
}

const REPOS = {
  middleware: 'ghcr.io/byte5ai/omadia-middleware',
  'web-ui': 'ghcr.io/byte5ai/omadia-web-ui',
};

describe('checkImages', () => {
  it('reports every service image for the target version', async () => {
    const asked = [];
    const result = await checkImages({
      engine: engineFor(REPOS),
      config: CONFIG,
      targetVersion: 'v0.140.1',
      manifestCheck: async (repo, tag) => {
        asked.push(`${repo}:${tag}`);
        return { exists: true };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.images.map((i) => i.image),
      [
        'ghcr.io/byte5ai/omadia-middleware:v0.140.1',
        'ghcr.io/byte5ai/omadia-web-ui:v0.140.1',
      ],
    );
    // The regression guard: the repo must not carry the running tag into the
    // asked-for reference (`repo:v0.136.2:v0.140.1`).
    assert.deepEqual(asked, [
      'ghcr.io/byte5ai/omadia-middleware:v0.140.1',
      'ghcr.io/byte5ai/omadia-web-ui:v0.140.1',
    ]);
  });

  it('is not ok when a single image is missing, and says which', async () => {
    const result = await checkImages({
      engine: engineFor(REPOS),
      config: CONFIG,
      targetVersion: 'v0.140.1',
      manifestCheck: async (repo) =>
        repo.endsWith('web-ui')
          ? { exists: false, reason: 'tag_not_found' }
          : { exists: true },
    });

    assert.equal(result.ok, false);
    assert.equal(result.images[0]?.available, true);
    assert.equal(result.images[1]?.available, false);
    assert.equal(result.images[1]?.reason, 'tag_not_found');
  });

  it('keeps an unreachable registry distinguishable from a missing tag', async () => {
    const result = await checkImages({
      engine: engineFor(REPOS),
      config: CONFIG,
      targetVersion: 'v0.140.1',
      manifestCheck: async () => ({
        exists: false,
        reason: 'registry_unreachable: ENOTFOUND',
      }),
    });

    assert.equal(result.ok, false);
    assert.match(result.images[0]?.reason ?? '', /registry_unreachable/);
  });

  it('reports an unresolvable service instead of throwing', async () => {
    const result = await checkImages({
      engine: engineFor({ middleware: REPOS.middleware }),
      config: CONFIG,
      targetVersion: 'v0.140.1',
      manifestCheck: async () => ({ exists: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.images[1]?.available, false);
    assert.match(result.images[1]?.reason ?? '', /resolve_failed/);
  });

  it('never checks a protected service, whatever the config says', async () => {
    const result = await checkImages({
      engine: engineFor({ ...REPOS, postgres: 'postgres' }),
      config: { ...CONFIG, services: ['middleware', 'postgres', 'updater'] },
      targetVersion: 'v0.140.1',
      manifestCheck: async () => ({ exists: true }),
    });

    assert.deepEqual(result.images.map((i) => i.service), ['middleware']);
  });
});
