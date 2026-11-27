/**
 * Memory-ACL plan, step 4a — the surfaces that could hand out memory, read
 * from the source: every mounted HTTP route, every native tool and every
 * PluginContext accessor method. `surfaceInventory.test.ts` fails when one
 * of them is missing from the hand-written table in `surfaceClassification.ts`.
 *
 * What counts as a surface (syntactic, TypeScript AST over `src/` and
 * `packages/<pkg>/src/`, tests excluded):
 *   routes    `app.<use|get|post|put|patch|delete|all>(…)` and
 *             `<…>routes.register(prefix, …)` (plugin routes)
 *   tools     `<…>nativeToolRegistry|tools.<register|registerHandler>(name, …)`,
 *             `registerNativeTool(name, …)`, and the kernel tools the
 *             orchestrator dispatches itself (`name === X_TOOL_NAME`)
 *   accessors every method of every object-typed member of `PluginContext`
 *             (type checker over `@omadia/plugin-api`)
 *
 * Keys are stable across line moves: file, verb and the argument as written.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '..', '..');

const ROUTE_VERBS = new Set(['use', 'get', 'post', 'put', 'patch', 'delete', 'all']);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!['node_modules', 'dist', 'test', '__tests__'].includes(name)) walk(p);
      } else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) {
        out.push(p);
      }
    }
  };
  walk(path.join(MIDDLEWARE_ROOT, 'src'));
  const packages = path.join(MIDDLEWARE_ROOT, 'packages');
  for (const pkg of readdirSync(packages)) {
    const src = path.join(packages, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // a package without src/
    }
  }
  return out.sort();
}

const unquote = (text: string): string => text.replace(/^'(.*)'$/, '$1');
const firstLine = (text: string): string => text.split('\n')[0]!;

export interface Surfaces {
  readonly routes: readonly string[];
  readonly tools: readonly string[];
  readonly accessors: readonly string[];
}

export function routesAndTools(): Pick<Surfaces, 'routes' | 'tools'> {
  const routes = new Set<string>();
  const tools = new Set<string>();
  for (const file of sourceFiles()) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const rel = path.relative(MIDDLEWARE_ROOT, file);
    const isOrchestrator = rel === 'packages/harness-orchestrator/src/orchestrator.ts';
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const a0 = n.arguments[0]!;
        if (ts.isPropertyAccessExpression(n.expression)) {
          const verb = n.expression.name.text;
          const recv = n.expression.expression.getText(sf);
          if (recv === 'app' && ROUTE_VERBS.has(verb)) {
            const last = n.arguments[n.arguments.length - 1]!;
            const handler = ts.isCallExpression(last)
              ? last.expression.getText(sf)
              : ts.isIdentifier(last) || ts.isPropertyAccessExpression(last)
                ? last.getText(sf)
                : '(inline)';
            const at = n.arguments.length > 1 ? unquote(a0.getText(sf)) : '(no path)';
            routes.add(`${rel} ${verb.toUpperCase()} ${at} ${handler}`);
          }
          if (/routes$/.test(recv) && verb === 'register') {
            routes.add(`${rel} PLUGIN ${unquote(a0.getText(sf))}`);
          }
          if (
            /(nativeToolRegistry|tools)$/.test(recv) &&
            (verb === 'register' || verb === 'registerHandler')
          ) {
            tools.add(`${rel} ${verb} ${unquote(firstLine(a0.getText(sf)))}`);
          }
          if (verb === 'registerNativeTool') {
            tools.add(`${rel} registerNativeTool ${firstLine(a0.getText(sf))}`);
          }
        }
        if (ts.isIdentifier(n.expression) && n.expression.text === 'registerNativeTool') {
          tools.add(`${rel} registerNativeTool ${firstLine(a0.getText(sf))}`);
        }
      }
      if (
        isOrchestrator &&
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        n.left.getText(sf) === 'name' &&
        /_TOOL_NAME$/.test(n.right.getText(sf))
      ) {
        tools.add(`${rel} dispatch ${n.right.getText(sf)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { routes: [...routes].sort(), tools: [...tools].sort() };
}

export function pluginContextAccessors(): string[] {
  const entry = path.join(MIDDLEWARE_ROOT, 'packages/plugin-api/src/index.ts');
  const program = ts.createProgram([entry], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
  const pc = checker.getExportsOfModule(mod).find((s) => s.name === 'PluginContext');
  if (!pc) throw new Error('PluginContext is no longer exported by @omadia/plugin-api');
  const out: string[] = [];
  for (const prop of checker.getDeclaredTypeOfSymbol(pc).getProperties()) {
    const type = checker.getNonNullableType(checker.getTypeOfSymbol(prop));
    if (type.getCallSignatures().length > 0) {
      out.push(prop.name);
      continue;
    }
    if (!(type.getFlags() & ts.TypeFlags.Object)) continue; // ids, flags
    for (const member of type.getProperties()) {
      const t = checker.getNonNullableType(checker.getTypeOfSymbol(member));
      if (t.getCallSignatures().length > 0) out.push(`${prop.name}.${member.name}`);
    }
  }
  return out.sort();
}
