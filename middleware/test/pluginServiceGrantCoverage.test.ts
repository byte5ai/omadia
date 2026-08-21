import { strict as assert } from 'node:assert';
import { Dirent, promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'node:test';
import ts from 'typescript';
import { parseDocument } from 'yaml';

import { parseCapabilityRef } from '@omadia/plugin-api';

import { LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20 } from '../src/platform/pluginServiceGrants.js';

const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES_ROOT = path.join(MIDDLEWARE_ROOT, 'packages');
const KERNEL_SRC_ROOT = path.join(MIDDLEWARE_ROOT, 'src');

interface ManifestInfo {
  readonly pluginId: string;
  readonly manifestPath: string;
  readonly packageRoot: string;
  readonly declaredNames: ReadonlySet<string>;
  /**
   * #788 — capabilities this manifest lists under `provides:` and NOWHERE
   * else. These are the names the runtime now refuses until the plugin has
   * actually called `provide()`, so a `services.get` on one of them is an
   * ordering bug waiting for the first turn that reaches it.
   *
   * A name that is also under `requires:`/`optional_requires:` is excluded:
   * the dependency declaration grants it outright, which is exactly what makes
   * the `replace()`-wrapping pattern legal.
   */
  readonly providesOnlyNames: ReadonlySet<string>;
  readonly sourceFiles: readonly string[];
}

interface ServiceUse {
  readonly capability: string;
  readonly file: string;
  readonly line: number;
  /**
   * Which `ctx.services` verb touched the name — #788 follow-up.
   *
   * `replace` runs the SAME grant gate as `get` (a name a plugin may not read
   * is a name it may not redefine), so an undeclared or provides-only
   * `replace` is the same latent runtime throw and has to be scanned for the
   * same way. Recorded rather than folded into `get` because the two produce
   * different remedies in the finding text.
   */
  readonly verb: 'get' | 'replace';
}

interface CoverageSnapshot {
  readonly manifests: readonly ManifestInfo[];
  readonly observedByPlugin: ReadonlyMap<string, readonly ServiceUse[]>;
  readonly undeclaredFindings: readonly string[];
  readonly scanFailures: readonly string[];
}

let cachedSnapshot: CoverageSnapshot | undefined;

describe('plugin service grant coverage', () => {
  it('every built-in services.get call is declared or allowlisted', async () => {
    const snapshot = await loadCoverageSnapshot();
    assert.deepEqual(
      snapshot.scanFailures,
      [],
      `service-grant scanner failed:\n${snapshot.scanFailures.join('\n')}`,
    );
    assert.deepEqual(
      snapshot.undeclaredFindings,
      [],
      `undeclared built-in service grants found:\n${snapshot.undeclaredFindings.join('\n')}`,
    );
  });

  it('no built-in resolves a capability it only declares under `provides:`', async () => {
    // #788 — the permanent form of the one-off audit that shipped with the
    // fix. `provides:` no longer grants a name until the plugin has actually
    // called `provide()` for it, so a bundled package that resolves a
    // provides-only capability now throws at runtime.
    //
    // This scan cannot see the ORDER of the two calls, and does not claim to:
    // it flags the read at all, which is the conservative direction. A
    // legitimate read-back is spelled by ALSO declaring the name
    // (`requires:`/`optional_requires:`) — a plugin that holds its own
    // implementation rarely needs the registry to hand it back.
    //
    // Deliberately NOT allowlist-aware: the legacy allowlist grandfathers
    // UNDECLARED names, and every name here is declared. There is no ramp to
    // fall back to, which is why the audit had to come back empty before the
    // gate could be tightened at all.
    const snapshot = await loadCoverageSnapshot();
    assert.deepEqual(
      snapshot.scanFailures,
      [],
      `service-grant scanner failed:\n${snapshot.scanFailures.join('\n')}`,
    );

    // A guard that scans nothing passes forever. `provides:` disappearing from
    // every bundled manifest, or the parser losing the block, must fail here
    // rather than turn this test into a green no-op.
    const packagesWithProvides = snapshot.manifests.filter(
      (m) => m.providesOnlyNames.size > 0,
    );
    assert.ok(
      packagesWithProvides.length >= 10,
      `only ${String(packagesWithProvides.length)} bundled packages declare a provides-only capability; the 2026-08-21 audit found 14. Either the manifests changed or the parser stopped reading \`provides:\`.`,
    );

    const findings: string[] = [];
    for (const manifest of packagesWithProvides) {
      for (const use of snapshot.observedByPlugin.get(manifest.pluginId) ?? []) {
        if (!manifest.providesOnlyNames.has(use.capability)) continue;
        findings.push(
          `${manifest.pluginId} ${verbPhrase(use.verb)} '${use.capability}' at ${use.file}:${String(use.line)}, ` +
            'but its manifest declares that capability only under `provides:`. Since #788 that ' +
            `call throws until the plugin has called ctx.services.provide('${use.capability}', …).` +
            (use.verb === 'replace'
              ? ' For a `replace` that fix is not even available: the live provider belongs to another plugin, and `provide` would throw duplicate-provider against it. Wrap your own registration instead, ' +
                `or add '${use.capability}@<major>' to `
              : ` Provide it before resolving it, or add '${use.capability}@<major>' to `) +
            '`requires:`/`optional_requires:` if this plugin consumes another plugin\'s implementation.',
        );
      }
    }

    assert.deepEqual(
      findings,
      [],
      `provides-only service reads found:\n${findings.join('\n')}`,
    );
  });

  it('the built-in allowlist has no stale rows', async () => {
    const snapshot = await loadCoverageSnapshot();
    assert.deepEqual(
      snapshot.scanFailures,
      [],
      `service-grant scanner failed:\n${snapshot.scanFailures.join('\n')}`,
    );

    const builtInIds = new Set(snapshot.manifests.map((m) => m.pluginId));
    const findings: string[] = [];

    // These plugin ids live in sibling repos outside this worktree. This repo
    // can verify their manifests were allowlisted intentionally, but it cannot
    // prove their current call sites still exist because their source is not
    // under middleware/packages/* here.
    const unverifiableStandaloneIds = new Set([
      '@omadia/agent-confluence',
      '@omadia/agent-odoo-accounting',
      '@omadia/agent-odoo-hr',
      '@omadia/channel-discord',
      '@omadia/channel-slack',
      '@omadia/channel-teams',
      '@omadia/channel-telegram',
      '@omadia/channel-whatsapp',
      '@omadia/integration-odoo',
    ]);

    for (const [pluginId, legacyNames] of Object.entries(
      LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20,
    )) {
      if (unverifiableStandaloneIds.has(pluginId)) continue;
      if (!builtInIds.has(pluginId)) continue;
      const observed = new Set(
        (snapshot.observedByPlugin.get(pluginId) ?? []).map((use) => use.capability),
      );
      for (const capability of legacyNames) {
        if (!observed.has(capability)) {
          findings.push(
            `${pluginId} still allowlists '${capability}', but no real built-in call site in middleware/packages/* now resolves it. Remove the stale row or restore the call before keeping it grandfathered.`,
          );
        }
      }
    }

    assert.deepEqual(
      findings,
      [],
      `stale built-in allowlist rows found:\n${findings.join('\n')}`,
    );
  });
});

async function loadCoverageSnapshot(): Promise<CoverageSnapshot> {
  if (cachedSnapshot) return cachedSnapshot;

  const manifests = await loadBuiltInManifests();
  const program = await createWorkspaceProgram();
  const checker = program.getTypeChecker();
  const scanFailures: string[] = [];
  const undeclaredFindings: string[] = [];
  const observedByPlugin = new Map<string, readonly ServiceUse[]>();

  for (const manifest of manifests) {
    const observed = collectServiceUsesForManifest(
      manifest,
      program,
      checker,
      scanFailures,
    );
    observedByPlugin.set(manifest.pluginId, observed);

    const declared = manifest.declaredNames;
    const legacy = new Set(
      LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20[manifest.pluginId] ?? [],
    );
    for (const use of observed) {
      if (declared.has(use.capability) || legacy.has(use.capability)) continue;
      undeclaredFindings.push(
        `${manifest.pluginId} ${verbPhrase(use.verb)} '${use.capability}' at ${use.file}:${String(use.line)} without declaring it. Either add '${use.capability}@<major>' to manifest.yaml or add a dated row to LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20 for this legacy pair.`,
      );
    }
  }

  cachedSnapshot = {
    manifests,
    observedByPlugin,
    undeclaredFindings,
    scanFailures,
  };
  return cachedSnapshot;
}

async function loadBuiltInManifests(): Promise<ManifestInfo[]> {
  const entries = await fs.readdir(PACKAGES_ROOT, { withFileTypes: true });
  const manifests: ManifestInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(PACKAGES_ROOT, entry.name);
    const manifestPath = path.join(packageRoot, 'manifest.yaml');
    try {
      await fs.access(manifestPath);
    } catch {
      continue;
    }
    manifests.push(await parseManifest(manifestPath, packageRoot));
  }

  manifests.sort((a, b) => a.pluginId.localeCompare(b.pluginId, 'en'));
  return manifests;
}

async function parseManifest(
  manifestPath: string,
  packageRoot: string,
): Promise<ManifestInfo> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(
      `${relativeToMiddleware(manifestPath)} failed to parse:\n${doc.errors
        .map((error) => String(error))
        .join('\n')}`,
    );
  }

  const parsed = doc.toJSON() as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `${relativeToMiddleware(manifestPath)} did not parse to an object manifest`,
    );
  }

  const identity = asRecord(parsed['identity']);
  const pluginId = asString(identity?.['id']);
  if (!pluginId) {
    throw new Error(
      `${relativeToMiddleware(manifestPath)} is missing identity.id`,
    );
  }

  const requires = asStringArray(parsed['requires'], manifestPath, 'requires');
  // #795 (re-mirrored for #584) — an optional dependency is still a
  // DECLARATION; the runtime's `declaredServiceNames()` counts it, so this
  // static mirror must too or the two gates contradict each other.
  const optionalRequires = asStringArray(
    parsed['optional_requires'],
    manifestPath,
    'optional_requires',
  );
  const provides = asStringArray(parsed['provides'], manifestPath, 'provides');
  const declaredNames = new Set<string>();
  for (const rawCapability of [...requires, ...optionalRequires, ...provides]) {
    declaredNames.add(parseCapabilityRef(rawCapability).name);
  }

  // #788 — `provides:` minus everything the manifest also declares as a
  // dependency.
  const consumeNames = new Set(
    [...requires, ...optionalRequires].map((raw) => parseCapabilityRef(raw).name),
  );
  const providesOnlyNames = new Set<string>();
  for (const raw of provides) {
    const name = parseCapabilityRef(raw).name;
    if (!consumeNames.has(name)) providesOnlyNames.add(name);
  }

  const sourceRoot = path.join(packageRoot, 'src');
  const sourceFiles = await collectTypeScriptFiles(sourceRoot);
  return {
    pluginId,
    manifestPath,
    packageRoot,
    declaredNames,
    providesOnlyNames,
    sourceFiles,
  };
}

async function createWorkspaceProgram(): Promise<ts.Program> {
  const packageEntries = await fs.readdir(PACKAGES_ROOT, { withFileTypes: true });
  const packageSourceFiles = await Promise.all(
    packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        collectTypeScriptFiles(path.join(PACKAGES_ROOT, entry.name, 'src')),
      ),
  );
  const allSourceFiles = [
    ...(await collectTypeScriptFiles(KERNEL_SRC_ROOT)),
    ...packageSourceFiles.flat(),
  ];
  const paths = await buildWorkspacePaths();
  return ts.createProgram({
    rootNames: allSourceFiles,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowJs: false,
      baseUrl: MIDDLEWARE_ROOT,
      paths,
    },
  });
}

async function buildWorkspacePaths(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const entries = await fs.readdir(PACKAGES_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(PACKAGES_ROOT, entry.name);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    try {
      const raw = await fs.readFile(packageJsonPath, 'utf8');
      const pkg = JSON.parse(raw) as { name?: unknown };
      if (typeof pkg.name !== 'string' || pkg.name.length === 0) continue;
      const srcIndex = path.relative(
        MIDDLEWARE_ROOT,
        path.join(packageRoot, 'src', 'index.ts'),
      );
      const srcWildcard = path.relative(
        MIDDLEWARE_ROOT,
        path.join(packageRoot, 'src', '*'),
      );
      out[pkg.name] = [srcIndex];
      out[`${pkg.name}/*`] = [srcWildcard];
    } catch {
      continue;
    }
  }
  return out;
}

function collectServiceUsesForManifest(
  manifest: ManifestInfo,
  program: ts.Program,
  checker: ts.TypeChecker,
  scanFailures: string[],
): readonly ServiceUse[] {
  const observed: ServiceUse[] = [];

  for (const filePath of manifest.sourceFiles) {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      scanFailures.push(
        `${manifest.pluginId} source file ${relativeToMiddleware(filePath)} was not loaded into the TypeScript program`,
      );
      continue;
    }

    walk(sourceFile, (node) => {
      const verb = gatedServiceCallVerb(node);
      if (verb === undefined) return;
      const call = node as ts.CallExpression;
      const firstArg = call.arguments[0];
      const location = formatNodeLocation(sourceFile, firstArg ?? call);
      if (!firstArg) {
        scanFailures.push(
          `${manifest.pluginId} uses ctx.services.${verb} with no argument at ${location}`,
        );
        return;
      }
      const resolved = resolveServiceName(firstArg, checker, verb);
      if ('error' in resolved) {
        scanFailures.push(`${manifest.pluginId} ${location}: ${resolved.error}`);
        return;
      }
      observed.push({
        capability: resolved.name,
        file: relativeToMiddleware(filePath),
        line: sourceFile.getLineAndCharacterOfPosition(firstArg.getStart()).line + 1,
        verb,
      });
    });
  }

  return observed;
}

const GATED_SERVICE_VERBS = new Set(['get', 'replace']);

/**
 * A gated `ctx.services.<verb>(name, …)` call. Returns the verb so the finding
 * can name the line the author actually wrote.
 *
 * `provide` is deliberately absent: it is not gated, because it cannot take a
 * live name away from anyone — `ServiceRegistry.provide` throws
 * duplicate-provider instead. Adding it here would report false findings for
 * every plugin that registers a name it did not spell in `provides:`.
 */
function gatedServiceCallVerb(node: ts.Node): 'get' | 'replace' | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const verb = callee.name.text;
  if (!GATED_SERVICE_VERBS.has(verb)) return undefined;
  const target = callee.expression;
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'services') {
    return undefined;
  }
  return verb as 'get' | 'replace';
}

function resolveServiceName(
  arg: ts.Expression,
  checker: ts.TypeChecker,
  verb: 'get' | 'replace' = 'get',
): { name: string } | { error: string } {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { name: arg.text };
  }
  if (!ts.isIdentifier(arg)) {
    return {
      error: `ctx.services.${verb} argument must be a string literal or identifier, saw ${ts.SyntaxKind[arg.kind]}`,
    };
  }
  const symbol = checker.getSymbolAtLocation(arg);
  if (!symbol) {
    return {
      error: `could not resolve identifier '${arg.text}' to a declaration`,
    };
  }
  return resolveLiteralFromSymbol(symbol, checker, new Set());
}

function resolveLiteralFromSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { name: string } | { error: string } {
  const target =
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (seen.has(target)) {
    return { error: `identifier resolution looped at '${target.getName()}'` };
  }
  seen.add(target);

  for (const declaration of target.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration)) {
      const initializer = declaration.initializer;
      if (
        initializer &&
        (ts.isStringLiteral(initializer) ||
          ts.isNoSubstitutionTemplateLiteral(initializer))
      ) {
        return { name: initializer.text };
      }
      if (initializer && ts.isIdentifier(initializer)) {
        const next = checker.getSymbolAtLocation(initializer);
        if (next) return resolveLiteralFromSymbol(next, checker, seen);
      }
    }
  }

  const sourcePaths = Array.from(
    new Set(
      (target.declarations ?? [])
        .map((declaration) => declaration.getSourceFile().fileName)
        .filter(Boolean),
    ),
  ).map(relativeToMiddleware);

  return {
    error:
      `identifier '${target.getName()}' does not resolve to a string-literal const in middleware/src or middleware/packages/*/src` +
      (sourcePaths.length > 0
        ? ` (declarations: ${sourcePaths.join(', ')})`
        : ''),
  };
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectTypeScriptFiles(fullPath)));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      out.push(fullPath);
    }
  }

  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(
  value: unknown,
  manifestPath: string,
  // All three are capability-ref lists with the same shape and the same
  // failure modes, so they parse through one path.
  field: 'requires' | 'optional_requires' | 'provides',
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `${relativeToMiddleware(manifestPath)} field '${field}' must be an array of strings`,
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(
        `${relativeToMiddleware(manifestPath)} field '${field}' contains a non-string capability entry`,
      );
    }
    out.push(entry);
  }
  return out;
}

/** "resolves" reads wrong for a `replace`; the finding has to name the verb
 *  the author actually wrote or it sends them hunting for the wrong call. */
function verbPhrase(verb: 'get' | 'replace'): string {
  return verb === 'replace' ? 'replaces the provider of' : 'resolves';
}

function relativeToMiddleware(absPath: string): string {
  return path.relative(MIDDLEWARE_ROOT, absPath).replaceAll(path.sep, '/');
}

function formatNodeLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return `${relativeToMiddleware(sourceFile.fileName)}:${String(pos.line + 1)}`;
}
