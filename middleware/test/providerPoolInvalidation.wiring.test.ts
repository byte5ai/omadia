/**
 * #1080 — composition-root wiring the unit suites cannot see.
 *
 * `providerPoolCredentialInvalidation.test.ts` proves the listener drops the
 * right pool entries, and `secretVaultWriteEvents.test.ts` proves the vaults
 * emit. Both stay green if `index.ts` never subscribes the listener to the
 * production vault, subscribes it on a scope the pool does not read, or drops
 * the catalog-change invalidations — which is exactly the #1080 regression
 * (a pool nothing ever invalidates). `src/index.ts` boots the whole middleware
 * on import, so, like `778RouteMounts.wiring.test.ts`, this pins the wiring
 * from the source text.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Line comments stripped: a subscription that only survives in a `//` comment
// must not satisfy these checks.
const src = readFileSync(resolve(middlewareRoot, 'src', 'index.ts'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

function indexOf(pattern: RegExp, what: string): number {
  const idx = src.search(pattern);
  assert.notEqual(idx, -1, `src/index.ts no longer contains ${what}`);
  return idx;
}

function body(startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  assert.notEqual(start, -1, `src/index.ts no longer contains ${startAnchor}`);
  const end = src.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `src/index.ts no longer contains ${endAnchor}`);
  return src.slice(start, end);
}

describe('#1080 boot wiring — the kernel provider pool follows vault writes', () => {
  it('subscribes the pool listener on the scope the pool reads, before any plugin activates', () => {
    const poolScope =
      /const kernelProviderPool = createLlmProviderPool\(\{\s*getSecret: \(k\) => secretVault\.get\('([^']+)', k\)/.exec(
        src,
      )?.[1];
    assert.ok(poolScope, 'kernelProviderPool must read its credentials from secretVault');

    const listenerMatch =
      /secretVault\.onWrite\(\s*createProviderPoolCredentialListener\(\{\s*pool: kernelProviderPool,\s*scope: '([^']+)'/.exec(
        src,
      );
    assert.ok(
      listenerMatch,
      'secretVault.onWrite(createProviderPoolCredentialListener({ pool: kernelProviderPool, … })) must be live code',
    );
    assert.equal(
      listenerMatch[1],
      poolScope,
      'the listener must watch the vault scope the pool resolves credentials from',
    );

    const activateIdx = indexOf(
      /await toolPluginRuntime\.activateAllInstalled\(\)/,
      'toolPluginRuntime.activateAllInstalled()',
    );
    assert.ok(
      listenerMatch.index < activateIdx,
      'the listener must be subscribed before the first plugin can resolve (and cache) a provider',
    );
  });

  it('a provider plugin (un)registration invalidates its pool entry', () => {
    assert.match(
      body('const registerProviderFromPlugin = ', 'const unregisterProviderFromPlugin = '),
      /kernelProviderPool\.invalidate\(descriptor\.id\)/,
    );
    assert.match(
      body('const unregisterProviderFromPlugin = ', '\n  };'),
      /kernelProviderPool\.invalidate\(id\)/,
    );
  });

  it('a vault write in the host scope re-sources the shared Anthropic client', () => {
    const listener = body(
      'secretVault.onWrite((event) => {',
      'const reactivateAgent = ',
    );
    assert.match(listener, /event\.scope !== ORCHESTRATOR_SECRET_SOURCE/);
    assert.match(listener, /sharedAnthropicClientRefresher\.refresh\(\)/);
    assert.match(
      src,
      /readVaultKey: \(\) =>\s*readProviderApiKey\(\s*\(k\) => secretVault\.get\(ORCHESTRATOR_SECRET_SOURCE, k\)/,
    );
  });
});
