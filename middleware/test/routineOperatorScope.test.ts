import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { publicPaths } from '../src/auth/publicPaths.js';

/**
 * #1025 made the cross-tenant routine scope a discriminated literal on
 * purpose: an optional owner is one a caller can forget, while
 * `{ kind: 'operator' }` is one a reviewer can grep for. The smart-card door
 * then showed what a grep is worth without a gate — it built that literal as
 * the FALLBACK for a click that named no principal, so a missing identity
 * widened rights to operator level. That fallback is gone: a click without a
 * usable `actor` is refused with `RoutineActorRequiredError`.
 *
 * This file turns the grep into the gate. Operator scope is built in exactly
 * one module, the operator router, and that router is only reachable with an
 * authenticated operator session: it is mounted behind `requireAuth`, and no
 * path under it is on the list that lets `requireAuth` wave a request through.
 */

const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '..');
const SRC_ROOT = path.join(MIDDLEWARE_ROOT, 'src');

/** The one module allowed to build operator scope, relative to `middleware/`. */
const OPERATOR_ROUTER = 'src/routes/routines.ts';
/** Where `src/index.ts` mounts it. */
const OPERATOR_MOUNT = '/api/v1/routines';

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listTsFiles(full);
      const isSource =
        entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
      return isSource ? [full] : [];
    }),
  );
  return nested.flat();
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** Look through `as const`, `satisfies …`, `<T>x` and parentheses. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * 1-based lines of every object-literal VALUE carrying `kind: 'operator'`.
 * The union member `{ kind: 'operator' }` in `routineRunner.ts` is a type
 * literal and the `{ kind: 'operator' }` in its doc comment is a comment —
 * neither is a value, which is why this walks the AST instead of matching text.
 */
function operatorScopeLiterals(fileName: string, text: string): number[] {
  const source = parse(fileName, text);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const isOperatorScope = node.properties.some((prop) => {
        if (!ts.isPropertyAssignment(prop) || propertyName(prop.name) !== 'kind') {
          return false;
        }
        const init = unwrap(prop.initializer);
        return ts.isStringLiteralLike(init) && init.text === 'operator';
      });
      if (isOperatorScope) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe('#1025 operator routine scope — one producer, behind the session gate', () => {
  it("only the operator router builds { kind: 'operator' }", async () => {
    const hits: string[] = [];
    for (const file of await listTsFiles(SRC_ROOT)) {
      const text = await fs.readFile(file, 'utf8');
      // Cheap pre-filter; the AST decides.
      if (!text.includes('operator')) continue;
      const rel = path.relative(MIDDLEWARE_ROOT, file).split(path.sep).join('/');
      for (const line of operatorScopeLiterals(file, text)) {
        hits.push(`${rel}:${String(line)}`);
      }
    }

    // Exactly the operator router. An EMPTY list fails too: it would mean the
    // scan no longer sees the one literal it exists to police, and a guard
    // that scans nothing passes forever.
    assert.deepEqual(
      [...new Set(hits.map((hit) => hit.replace(/:\d+$/, '')))],
      [OPERATOR_ROUTER],
      "{ kind: 'operator' } is cross-tenant routine scope. Build it only in " +
        `${OPERATOR_ROUTER}, whose mount is authenticated. A door that cannot ` +
        'name its principal must refuse (see RoutineActorRequiredError), never ' +
        `fall back to operator scope. Found: ${hits.join(', ') || 'nothing'}`,
    );
  });

  it('the operator router is mounted behind requireAuth', async () => {
    const indexPath = path.join(SRC_ROOT, 'index.ts');
    const source = parse(indexPath, await fs.readFile(indexPath, 'utf8'));
    const mounts: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'use'
      ) {
        const [first] = node.arguments;
        if (first && ts.isStringLiteralLike(first) && first.text === OPERATOR_MOUNT) {
          mounts.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    assert.equal(
      mounts.length,
      1,
      `expected exactly one app.use('${OPERATOR_MOUNT}', …) in src/index.ts`,
    );
    const [mount] = mounts;
    assert.ok(mount);
    const [, guard, router] = mount.arguments.map((arg) => arg.getText(source));
    assert.equal(
      guard,
      'requireAuth',
      `${OPERATOR_MOUNT} runs every mutation cross-tenant; it must sit directly behind requireAuth`,
    );
    assert.match(router ?? '', /^createRoutinesRouter\(/);
  });

  it('no path under the operator mount is exempt from the session gate', () => {
    // `requireAuth` waves a request through when its `originalUrl` matches
    // one of these patterns — including the instance on the mount above.
    const allowlist = publicPaths();
    const id = '00000000-0000-4000-8000-000000000001';
    const operatorPaths = [
      OPERATOR_MOUNT,
      `${OPERATOR_MOUNT}/`,
      `${OPERATOR_MOUNT}/${id}`,
      `${OPERATOR_MOUNT}/${id}/status`,
      `${OPERATOR_MOUNT}/${id}/trigger`,
      `${OPERATOR_MOUNT}/${id}/template`,
      `${OPERATOR_MOUNT}/${id}/status?via=card`,
    ];
    for (const url of operatorPaths) {
      assert.equal(
        allowlist.some((pattern) => pattern.test(url)),
        false,
        `${url} must not bypass requireAuth`,
      );
    }
  });
});
