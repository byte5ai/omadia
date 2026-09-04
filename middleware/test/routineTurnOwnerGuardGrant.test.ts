/**
 * #1016 — the guard's service name has to agree in three places that cannot
 * import each other, and the plugin's manifest has to declare it.
 *
 * This exists because the first round of the wiring shipped a `services.get`
 * on a name no manifest declared. `assertServiceGranted` is fail-closed, the
 * call sits near the top of `activate()`, and `toolPluginRuntime` catches the
 * throw as an activation failure — so `chatAgent@1` was never published and
 * every channel that declares `requires: ["chatAgent@^1"]` skipped activation.
 * A guard that is meant to harden one dispatch took chat down on every boot.
 *
 * `pluginServiceGrantCoverage.test.ts` catches the undeclared-name half
 * repo-wide. What it cannot catch is the string drifting: the kernel publishes
 * under an exported constant, the plugin reads a literal in a package that
 * cannot import that constant, and the manifest repeats it a third time. Each
 * would keep compiling on its own while the guard silently stopped resolving —
 * which looks exactly like the supported "no provider installed" state.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'node:test';
import { parseDocument } from 'yaml';

import { parseCapabilityRef } from '@omadia/plugin-api';

import { ROUTINE_TURN_OWNER_GUARD_SERVICE } from '../packages/harness-orchestrator/src/plugin.js';
import { ROUTINE_TURN_OWNER_GUARD_SERVICE_NAME } from '../src/plugins/routines/index.js';

const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '..');
const ORCHESTRATOR_MANIFEST = path.join(
  MIDDLEWARE_ROOT,
  'packages/harness-orchestrator/manifest.yaml',
);

/** Every capability name the manifest declares, in any of the three blocks. */
function declaredCapabilityNames(manifestPath: string): ReadonlySet<string> {
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'));
  const names = new Set<string>();
  for (const block of ['requires', 'optional_requires', 'provides'] as const) {
    const raw = doc.get(block);
    const list = raw && typeof (raw as { toJSON?: unknown }).toJSON === 'function'
      ? ((raw as { toJSON: () => unknown }).toJSON() as unknown)
      : raw;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      names.add(parseCapabilityRef(entry).name);
    }
  }
  return names;
}

describe('routineTurnOwnerGuard service grant (#1016)', () => {
  it('the kernel constant and the plugin-side literal are the same name', () => {
    // The kernel publishes under its exported constant; the plugin reads a
    // literal because the app layer imports packages and never the reverse.
    assert.equal(
      ROUTINE_TURN_OWNER_GUARD_SERVICE,
      ROUTINE_TURN_OWNER_GUARD_SERVICE_NAME,
      'the orchestrator package and the kernel must name the same service',
    );
  });

  it('the orchestrator manifest declares the guard service', () => {
    const declared = declaredCapabilityNames(ORCHESTRATOR_MANIFEST);
    assert.ok(
      declared.has(ROUTINE_TURN_OWNER_GUARD_SERVICE),
      `harness-orchestrator/manifest.yaml must declare "${ROUTINE_TURN_OWNER_GUARD_SERVICE}" — ` +
        'without it the grant gate throws ServiceNotDeclaredError out of activate() ' +
        `and chatAgent@1 is never published. Declared: ${[...declared].sort().join(', ')}`,
    );
  });

  it('declares it as optional, so a host without the service still boots', () => {
    const doc = parseDocument(readFileSync(ORCHESTRATOR_MANIFEST, 'utf8'));
    const optional = (doc.get('optional_requires') as { toJSON?: () => unknown } | null)?.toJSON?.();
    assert.ok(Array.isArray(optional), 'optional_requires must be a list');
    const names = (optional as string[]).map((ref) => parseCapabilityRef(ref).name);
    assert.ok(
      names.includes(ROUTINE_TURN_OWNER_GUARD_SERVICE),
      'the guard must sit under optional_requires, not requires: a hard require ' +
        'would block chat on every host that publishes no such service',
    );
  });

  it('resolves the guard with getOptional, the verb optional_requires pairs with', () => {
    const source = readFileSync(
      path.join(MIDDLEWARE_ROOT, 'packages/harness-orchestrator/src/plugin.ts'),
      'utf8',
    );
    // `get` would advertise a hard prerequisite for a name the manifest marks
    // optional. Both verbs are declaration-gated, so this is about the
    // contract, not about whether the call throws.
    assert.match(
      source,
      /ctx\.services\.getOptional<[\s\S]{0,200}?>\(\s*ROUTINE_TURN_OWNER_GUARD_SERVICE\s*\)/,
      'plugin.ts must resolve the guard via ctx.services.getOptional(ROUTINE_TURN_OWNER_GUARD_SERVICE)',
    );
    assert.doesNotMatch(
      source,
      /ctx\.services\.get<[^>]*>\(\s*ROUTINE_TURN_OWNER_GUARD_SERVICE\s*\)/,
      'plugin.ts must not resolve the guard with the hard-require verb',
    );
  });

  it('does not hardcode the service name at the call site', () => {
    const source = readFileSync(
      path.join(MIDDLEWARE_ROOT, 'packages/harness-orchestrator/src/plugin.ts'),
      'utf8',
    );
    // One literal, in the exported constant, so this test can compare it to
    // the kernel's. A second inline copy would drift past every other check.
    const literals = source.match(/'routineTurnOwnerGuard'/g) ?? [];
    assert.equal(
      literals.length,
      1,
      'the service name must appear exactly once in plugin.ts, in ROUTINE_TURN_OWNER_GUARD_SERVICE',
    );
  });
});
