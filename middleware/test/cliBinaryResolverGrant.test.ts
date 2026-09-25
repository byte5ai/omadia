/**
 * #1085 — the CLI binary resolution rule has to reach the spawn sites, and the
 * name it travels under has to agree in three places that cannot import each
 * other.
 *
 * The bug this guards: `cliChatAgent` spawned its own `'claude'` constant
 * while the version badge, the login flow and the "Install now" button all
 * resolved through `resolveCliBin()` (runtime install dir first, PATH second).
 * An operator could install a newer CLI through the UI, watch the badge
 * update, and have every turn keep running the image binary — including the
 * version probe that decides whether `--restricted` is passed, so the spawn
 * gate silently dropped a layer on a deployment the UI called up to date.
 *
 * The fix publishes the rule as a kernel service. That puts the same
 * three-way drift risk in place as `routineTurnOwnerGuardGrant.test.ts`
 * describes: the kernel provides under an exported constant, the plugin reads
 * a literal in a package that cannot import that constant, and the manifest
 * repeats it a third time. Each half keeps compiling alone while the resolver
 * silently stops resolving — which looks exactly like the supported "no
 * resolver published" state, i.e. like the bug coming back.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, it } from 'node:test';
import { parseDocument } from 'yaml';

import { parseCapabilityRef } from '@omadia/plugin-api';

import { CLI_BINARY_RESOLVER_SERVICE } from '../packages/harness-orchestrator/src/plugin.js';
import { CLI_BINARY_RESOLVER_SERVICE_NAME } from '../src/platform/cliBackendDetector.js';

const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '..');
const ORCHESTRATOR_MANIFEST = path.join(
  MIDDLEWARE_ROOT,
  'packages/harness-orchestrator/manifest.yaml',
);
const PLUGIN_SOURCE = path.join(
  MIDDLEWARE_ROOT,
  'packages/harness-orchestrator/src/plugin.ts',
);
const KERNEL_SOURCE = path.join(MIDDLEWARE_ROOT, 'src/index.ts');

describe('cliBinaryResolver service grant (#1085)', () => {
  it('the kernel publishes the rule before any plugin activates', () => {
    // The first half of the chain. Every other pin here stays green with this
    // provide deleted: the orchestrator reads the service with getOptional, so
    // its absence is the supported "no resolver" state and every turn quietly
    // spawns from PATH again. Read out of `index.ts` source, like
    // `coreMigrationsBootWiring.test.ts`, because importing it boots the
    // whole middleware.
    const source = readFileSync(KERNEL_SOURCE, 'utf8');
    const provide = source.search(
      /\n {2}serviceRegistry\.provide\(\s*CLI_BINARY_RESOLVER_SERVICE_NAME,\s*\(bin: string\): string => resolveCliBin\(bin\),?\s*\);/,
    );
    assert.notEqual(
      provide,
      -1,
      'index.ts must provide CLI_BINARY_RESOLVER_SERVICE_NAME as `(bin) => resolveCliBin(bin)` ' +
        "at main()'s top level, not inside a branch",
    );
    const activate = source.indexOf('await toolPluginRuntime.activateAllInstalled()');
    assert.notEqual(activate, -1, 'could not find activateAllInstalled() in index.ts');
    assert.ok(
      provide < activate,
      'the resolver must be provided BEFORE activateAllInstalled(): the orchestrator ' +
        'resolves it once in activate(), so a later provide is never seen',
    );
  });


  it('the kernel constant and the plugin-side literal are the same name', () => {
    assert.equal(
      CLI_BINARY_RESOLVER_SERVICE,
      CLI_BINARY_RESOLVER_SERVICE_NAME,
      'the orchestrator package and the kernel must name the same service',
    );
  });

  it('the orchestrator manifest declares the resolver service', () => {
    const doc = parseDocument(readFileSync(ORCHESTRATOR_MANIFEST, 'utf8'));
    const names = new Set<string>();
    for (const block of ['requires', 'optional_requires', 'provides'] as const) {
      const list = (doc.get(block) as { toJSON?: () => unknown } | null)?.toJSON?.();
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === 'string') names.add(parseCapabilityRef(entry).name);
      }
    }
    assert.ok(
      names.has(CLI_BINARY_RESOLVER_SERVICE),
      `harness-orchestrator/manifest.yaml must declare "${CLI_BINARY_RESOLVER_SERVICE}" — ` +
        'without it the grant gate throws ServiceNotDeclaredError out of activate() ' +
        `and chatAgent@1 is never published. Declared: ${[...names].sort().join(', ')}`,
    );
  });

  it('declares it as optional, so a host without the resolver still boots', () => {
    const doc = parseDocument(readFileSync(ORCHESTRATOR_MANIFEST, 'utf8'));
    const optional = (doc.get('optional_requires') as { toJSON?: () => unknown } | null)?.toJSON?.();
    assert.ok(Array.isArray(optional), 'optional_requires must be a list');
    const names = (optional as string[]).map((ref) => parseCapabilityRef(ref).name);
    assert.ok(
      names.includes(CLI_BINARY_RESOLVER_SERVICE),
      'the resolver must sit under optional_requires: absent, the CLI paths fall ' +
        'back to PATH, which is a supported state and must not block chat',
    );
  });

  it('resolves it with getOptional, the verb optional_requires pairs with', () => {
    const source = readFileSync(PLUGIN_SOURCE, 'utf8');
    assert.match(
      source,
      /ctx\.services\.getOptional<[\s\S]{0,200}?>\(\s*\n?\s*CLI_BINARY_RESOLVER_SERVICE,?\s*\n?\s*\)/,
      'plugin.ts must resolve the rule via ctx.services.getOptional(CLI_BINARY_RESOLVER_SERVICE)',
    );
    assert.doesNotMatch(
      source,
      /ctx\.services\.get<[^>]*>\(\s*CLI_BINARY_RESOLVER_SERVICE\s*\)/,
      'plugin.ts must not resolve it with the hard-require verb',
    );
  });

  it('does not hardcode the service name at the call site', () => {
    const source = readFileSync(PLUGIN_SOURCE, 'utf8');
    const literals = source.match(/'cliBinaryResolver'/g) ?? [];
    assert.equal(
      literals.length,
      1,
      'the service name must appear exactly once in plugin.ts, in CLI_BINARY_RESOLVER_SERVICE',
    );
  });

  it('every CLI sub-agent spawn site hands the resolved binary in', async () => {
    // `createCliSubAgent` builds its OWN CliChatAgent deps — it inherits
    // nothing from the chat agent — so each call site has to pass the rule.
    // Miss one and the main turn runs the operator's installed CLI while that
    // sub-agent keeps spawning whatever PATH resolves: the original bug,
    // surviving in a corner nobody looks at.
    //
    // Scanned across the kernel AND every workspace package, not just the
    // orchestrator: a channel or agent plugin that grows a sub-agent is the
    // likeliest place for the next forgotten call site. The call text is cut
    // at its real closing paren rather than a fixed window, so a neighbouring
    // branch that does pass the option cannot vouch for one that does not —
    // the shape `dynamicAgentRuntime.ts` already has.
    //
    // KNOWN BLIND SPOT: the check is textual, so it proves the option was not
    // FORGOTTEN — not that it is live. A site written as the conditional
    // spread `...(maybeResolver ? { resolveCliBinary: maybeResolver } : {})`
    // — the legitimate shape at `subAgentTools.ts:117` — passes this guard
    // even when `maybeResolver` is never populated, and spawns from PATH.
    // Green here is not proof the binary is resolved; the kernel-provide pin
    // above, the forward pin below and the DB sub-agent spawn test in
    // `agentBuilderSubAgentTools.test.ts` carry that half.
    const missing: string[] = [];
    for (const root of [
      path.join(MIDDLEWARE_ROOT, 'src'),
      ...(await packageSourceRoots()),
    ]) {
      for (const file of await walkTypescript(root)) {
        const source = readFileSync(file, 'utf8');
        let from = source.indexOf('createCliSubAgent(');
        while (from !== -1) {
          const lineStart = source.lastIndexOf('\n', from) + 1;
          const lineText = source.slice(lineStart, source.indexOf('\n', from));
          // The declaration and the barrel re-export are not spawns. Matched
          // narrowly on the `{ ... } from` forms: `export const x =
          // createCliSubAgent(...)` IS a spawn and must stay in scope.
          const isCall =
            !/^\s*(import|export)\s*\{/.test(lineText) &&
            !lineText.includes('function createCliSubAgent');
          const call = callText(source, source.indexOf('(', from));
          if (isCall && !call.includes('resolveCliBinary')) {
            const line = source.slice(0, from).split('\n').length;
            missing.push(`${path.relative(MIDDLEWARE_ROOT, file)}:${line}`);
          }
          from = source.indexOf('createCliSubAgent(', from + 1);
        }
      }
    }
    assert.deepEqual(
      missing,
      [],
      'these createCliSubAgent call sites spawn without resolving the binary ' +
        '(#1085) — pass resolveCliBinary, e.g. resolveClaudeCliBin from ' +
        'src/platform/cliBinary.ts',
    );
  });

  it('forwards the resolved rule into the CLI agent, per turn', () => {
    // The service can be published, declared and resolved and STILL not reach
    // the spawn: the bug was a missing forward, not a missing rule. A wrapper
    // (`() => resolve(name)`) rather than a resolved string, because
    // `resolveCliBin` checks the filesystem per call — that is what makes an
    // install visible on the next turn instead of the next restart.
    const plugin = readFileSync(PLUGIN_SOURCE, 'utf8');
    assert.match(
      plugin,
      /resolveCliBinary: \(\): string => cliBinaryResolver\(DEFAULT_CLI_BINARY\)/,
      'plugin.ts must pass a per-call resolver into the orchestrator deps',
    );

    const build = readFileSync(
      path.join(MIDDLEWARE_ROOT, 'packages/harness-orchestrator/src/buildOrchestrator.ts'),
      'utf8',
    );
    assert.match(
      build,
      /resolveCliBinary: deps\.resolveCliBinary/,
      'buildOrchestrator must forward the resolver into CliChatAgent',
    );
  });
});

/** Every `.ts` file under `root`, skipping build output and fixtures. */
async function walkTypescript(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await walkTypescript(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The `src` directory of every workspace package under `packages/`. */
async function packageSourceRoots(): Promise<readonly string[]> {
  const packagesDir = path.join(MIDDLEWARE_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(packagesDir, entry.name, 'src');
    if (existsSync(src)) roots.push(src);
  }
  return roots;
}

/**
 * The text of a call whose opening paren is at `open`, cut at its own closing
 * paren. Depth-counted over `()`, `{}` and `[]`, skipping string and template
 * literals and both comment forms, so nested calls and objects stay inside and
 * the next statement stays out. A fixed-size window cannot do that: it lets a
 * neighbouring call's option vouch for a site that omits it.
 */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (let j = i + 1; j < source.length; j += 1) {
        if (source[j] === '\\') {
          j += 1;
          continue;
        }
        if (source[j] === ch) {
          i = j;
          break;
        }
      }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}
