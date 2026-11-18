/**
 * #1451 — composition-root wiring for the uninstall of a provider plugin that
 * shadowed a BUILT-IN provider id.
 *
 * `llmProviderBuiltinShadowing.test.ts` proves the catalog restores the bundled
 * descriptor. That alone leaves the running consumers on whatever they resolved
 * while the plugin was installed, and the orchestrator is rebuilt on the next
 * setup save against a provider whose models just changed underneath it. The
 * kernel therefore has to refresh discovery and rebuild the class-ref consumers
 * on the uninstall path, exactly as it already does on the install path.
 *
 * `src/index.ts` boots the whole middleware on import, so — like
 * `providerPoolInvalidation.wiring.test.ts` — this pins the wiring from the
 * source text, with line comments stripped so a commented-out call cannot
 * satisfy the checks.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(middlewareRoot, 'src', 'index.ts'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

function body(startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  assert.notEqual(start, -1, `src/index.ts no longer contains ${startAnchor}`);
  const end = src.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `src/index.ts no longer contains ${endAnchor}`);
  return src.slice(start, end);
}

describe('#1451 boot wiring — uninstalling a shadowing provider plugin heals the consumers', () => {
  it('refreshes discovery and rebuilds the class-ref consumers after the restore', () => {
    const unregister = body('const unregisterProviderFromPlugin = ', '\n  };');
    assert.match(
      unregister,
      /modelCatalogSync\.refresh\(id\)/,
      'a restored built-in must re-run discovery — it is a known provider again',
    );
    assert.match(
      unregister,
      /classDefaultRebuilder\.onDefaultsChanged\(id\)/,
      'the orchestrator, verifier and extras must be rebuilt off the restored catalog',
    );
  });

  it('logs a warning when a plugin registers under a bundled provider id', () => {
    const register = body(
      'const registerProviderFromPlugin = ',
      'const unregisterProviderFromPlugin = ',
    );
    const guarded = /if \(llmProviderCatalog\.isBundled\(descriptor\.id\)\) \{\s*console\.warn\(/;
    assert.match(
      register,
      guarded,
      'taking over a built-in id was silent — it must warn, not just be detected',
    );
  });
});
