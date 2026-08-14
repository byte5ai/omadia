import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { resolvePlatform } from '../src/update/platform.js';

/**
 * #432 follow-up — platform detection for the manual update instructions.
 *
 * The value of this is entirely in NOT guessing: a wrong app name in a
 * copy-pasteable `fly deploy` line is worse than a `<middleware-app>`
 * placeholder, because the placeholder is obviously incomplete and the wrong
 * name is not.
 */

describe('resolvePlatform', () => {
  it('reports Fly with the app name and machine id', () => {
    assert.deepEqual(
      resolvePlatform({
        FLY_APP_NAME: 'omadia-middleware-a1b2c3',
        FLY_MACHINE_ID: '148e392a7e1234',
      }),
      {
        kind: 'fly',
        appName: 'omadia-middleware-a1b2c3',
        machineId: '148e392a7e1234',
      },
    );
  });

  it('still reports Fly when only the app name is set', () => {
    // The app name is what the command needs; the machine id is a bonus.
    assert.deepEqual(resolvePlatform({ FLY_APP_NAME: 'app' }), {
      kind: 'fly',
      appName: 'app',
    });
  });

  it('reports unknown rather than guessing anywhere else', () => {
    for (const env of [
      {},
      { FLY_APP_NAME: '' },
      { FLY_APP_NAME: '   ' },
      { FLY_MACHINE_ID: '148e392a7e1234' },
      { HOSTNAME: 'omadia-middleware-1', DOCKER_HOST: 'unix:///var/run/docker.sock' },
    ]) {
      assert.deepEqual(
        resolvePlatform(env),
        { kind: 'unknown' },
        `${JSON.stringify(env)} must not be read as a platform`,
      );
    }
  });

  it('trims whitespace picked up from the environment', () => {
    const resolved = resolvePlatform({
      FLY_APP_NAME: '  app  ',
      FLY_MACHINE_ID: ' m1 ',
    });
    assert.equal(resolved.appName, 'app');
    assert.equal(resolved.machineId, 'm1');
  });
});
