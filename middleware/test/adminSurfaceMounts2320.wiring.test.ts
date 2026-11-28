/**
 * #2320 — composition-root wiring for the admin surfaces of the keychain,
 * skills, sandboxes and published apps. Same reasoning as
 * `778RouteMounts.wiring.test.ts`: a router's own tests mount it into a
 * throwaway app and pass whether or not `src/index.ts` ever mounts it, and
 * `index.ts` cannot be booted from a unit test — so this reads the live
 * (comment-stripped) source of the composition root.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(resolve(middlewareRoot, 'src', 'index.ts'), 'utf8');
const liveIndexSource = indexSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

interface Mount {
  readonly path: string;
  readonly factory: string;
  readonly module: string;
}

const MOUNTS: readonly Mount[] = [
  { path: '/api/v1/admin/credentials', factory: 'createAdminCredentialsRouter', module: 'adminCredentials' },
  { path: '/api/v1/admin/skills', factory: 'createSkillPromotionRouter', module: 'skillPromotion' },
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

describe('#2320 — index.ts mounts the admin surface routers', () => {
  for (const mount of MOUNTS) {
    it(`imports ${mount.factory} from routes/${mount.module}.js`, () => {
      assert.match(
        liveIndexSource,
        new RegExp(`import\\s*\\{[^}]*\\b${mount.factory}\\b[^}]*\\}\\s*from\\s*'\\./routes/${mount.module}\\.js';`),
      );
    });

    it(`mounts ${mount.factory} at ${mount.path} behind requireAuth`, () => {
      assert.match(
        liveIndexSource,
        new RegExp(`app\\.use\\(\\s*'${escape(mount.path)}',\\s*requireAuth,\\s*${mount.factory}\\(`),
        `app.use('${mount.path}', requireAuth, ${mount.factory}(...)) must be live code in index.ts`,
      );
    });
  }
});
