/**
 * #1346 / #1086 — the per-turn `isAvailable` predicate must survive every hop
 * between the place it is declared and the registry the orchestrator reads.
 *
 * The behaviour tests (`toolAvailability1346.test.ts`,
 * `turnBoundToolsAvailability.test.ts`) register straight on the registry or
 * use a fake plugin context, so dropping one of these forwards would leave
 * them green while both fixes regress. `src/index.ts` boots the whole
 * middleware on import, so — like `routineWebSender.wiring.test.ts` — these
 * pins read the source.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string =>
  readFileSync(resolve(middlewareRoot, ...parts), 'utf8');

const FORWARD = /\.\.\.\(options\??\.isAvailable !== undefined\s*\?\s*\{ isAvailable: options\??\.isAvailable \}/g;

describe('#1346 — isAvailable is forwarded into the native-tool registry', () => {
  it('ctx.tools.register AND ctx.tools.registerHandler forward it (src/platform/pluginContext.ts)', () => {
    const matches = read('src', 'platform', 'pluginContext.ts').match(FORWARD) ?? [];
    assert.equal(matches.length, 2, 'both plugin registration paths must forward isAvailable');
  });

  it('the registry keeps it on both register paths (nativeToolRegistry.ts)', () => {
    const src = read('packages', 'harness-orchestrator', 'src', 'nativeToolRegistry.ts');
    const matches = src.match(FORWARD) ?? [];
    assert.equal(matches.length, 2, 'register() and registerHandler() must store isAvailable');
  });

  it("the kernel's manage_routine registration forwards it (src/index.ts)", () => {
    const src = read('src', 'index.ts');
    const start = src.indexOf('registerNativeTool: (name, handler, options) =>');
    assert.notEqual(start, -1, 'registerNativeTool wiring not found');
    const block = src.slice(start, src.indexOf('proactiveSenders:', start));
    assert.match(block, /isAvailable: options\.isAvailable/);
  });

  it('initRoutines registers manage_routine with isManageRoutineOffered', () => {
    const src = read('src', 'plugins', 'routines', 'initRoutines.ts');
    assert.match(src, /isAvailable: isManageRoutineOffered/);
  });
});
