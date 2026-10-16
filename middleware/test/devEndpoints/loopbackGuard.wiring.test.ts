/**
 * #1350 — composition-root wiring for the `/api/dev` loopback guard.
 *
 * The e2e suite drives `mountDevLoopbackGuard` through a harness that copies
 * the production mount order; it stays green if `src/index.ts` stops calling
 * the guard, or calls it after the plugin routes are mounted — which is the
 * exact shape of #1350 (the guard existed, but not where the memory browser
 * was mounted). `src/index.ts` boots at import time, so, like
 * `778RouteMounts.wiring.test.ts`, this reads its source instead.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const liveIndexSource = readFileSync(resolve(middlewareRoot, 'src', 'index.ts'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

function offsetOf(needle: string): number {
  const at = liveIndexSource.indexOf(needle);
  assert.ok(at >= 0, `src/index.ts no longer contains live code \`${needle}\``);
  return at;
}

describe('#1350 — index.ts mounts the /api/dev loopback guard first', () => {
  it('passes DEV_ENDPOINTS_LOOPBACK_ONLY to mountDevLoopbackGuard', () => {
    assert.match(
      liveIndexSource,
      /mountDevLoopbackGuard\(app,\s*\{\s*loopbackOnly:\s*config\.DEV_ENDPOINTS_LOOPBACK_ONLY\s*\}\)/,
    );
  });

  it('mounts the guard before the graph browser and the plugin routes', () => {
    const guard = offsetOf('mountDevLoopbackGuard(app,');
    assert.ok(guard < offsetOf('mountDevGraph(app,'), 'guard must precede mountDevGraph');
    assert.ok(
      guard < offsetOf('pluginRouteRegistry.mountAll(app)'),
      'guard must precede pluginRouteRegistry.mountAll',
    );
  });
});
