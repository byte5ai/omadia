#!/usr/bin/env node
/**
 * #1959 — find `t('key')` calls whose key exists in NO catalog.
 *
 * `i18n-validate.mjs` compares the catalogs with each other, so a key that is
 * missing in both passes it, and the page then renders the raw key
 * (`adminMcp.servers.structuredOutput` was such a case). This scan closes that
 * gap for the calls it can resolve statically:
 *
 *   const t = useTranslations('adminMcp');     // or await getTranslations(...)
 *   t('servers.structuredOutput')              // → adminMcp.servers.structuredOutput
 *
 * Only a translator bound in the SAME file to a literal namespace, called with
 * a plain string literal, is checked; `t(\`x.${y}\`)`, `t(key)` and translators
 * handed in as props are skipped (they cannot be resolved without running the
 * code). `t.rich`, `t.markup` and `t.raw` count like `t`; `t.has` does not.
 *
 * Ratchet (ADR-0159): `--ceiling <file>` fails when the number of unresolved
 * keys exceeds the ceiling, and asks for the ceiling to be lowered when it has
 * dropped. Without `--ceiling` it prints the list and exits 0.
 *
 * Usage:
 *   node scripts/i18n-missing-keys.mjs
 *   node scripts/i18n-missing-keys.mjs --ceiling scripts/i18n-missing-keys-ceiling.json
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const APP_DIR = resolve(ROOT, 'app');
const REFERENCE_CATALOG = resolve(ROOT, 'messages', 'en.json');

const TRANSLATOR_FACTORIES = new Set(['useTranslations', 'getTranslations']);
const COUNTED_MEMBERS = new Set(['rich', 'markup', 'raw']);

function flattenKeys(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.add(full);
      flattenKeys(value, full, out);
    } else {
      out.add(full);
    }
  }
  return out;
}

/** `useTranslations('ns')` / `await getTranslations('ns')` → `'ns'`, else undefined. */
function literalNamespace(init) {
  let expr = init;
  if (expr && ts.isAwaitExpression(expr)) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return undefined;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || !TRANSLATOR_FACTORIES.has(callee.text)) return undefined;
  const [arg] = expr.arguments;
  if (arg === undefined) return '';
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isObjectLiteralExpression(arg)) {
    const ns = arg.properties.find(
      (p) => ts.isPropertyAssignment(p) && p.name.getText() === 'namespace',
    );
    if (ns && ts.isPropertyAssignment(ns) && ts.isStringLiteral(ns.initializer)) {
      return ns.initializer.text;
    }
    return '';
  }
  return undefined;
}

/** Function-like nodes open a scope: a `t` bound in one component must not
 *  resolve calls in another component of the same file. */
function opensScope(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function lookup(scopes, name) {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    if (scopes[i].has(name)) return scopes[i].get(name);
  }
  return undefined;
}

/** Bindings declared directly in this scope (not in nested functions). */
function declareScope(node, scope) {
  const visit = (child) => {
    if (opensScope(child)) return;
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) {
      const ns = literalNamespace(child.initializer);
      // A same-named binding to something else shadows an outer translator.
      scope.set(child.name.text, ns);
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
}

function scanFile(path, known) {
  const text = readFileSync(path, 'utf8');
  if (!/useTranslations|getTranslations/.test(text)) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const missing = [];
  const scopes = [];

  const enter = (node) => {
    const scope = new Map();
    if (opensScope(node)) {
      for (const param of node.parameters ?? []) {
        if (ts.isIdentifier(param.name)) scope.set(param.name.text, undefined);
      }
    }
    declareScope(node, scope);
    scopes.push(scope);
  };

  const visit = (node) => {
    const scoped = opensScope(node);
    if (scoped) enter(node);
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && COUNTED_MEMBERS.has(callee.name.text)) {
        callee = callee.expression;
      }
      const [arg] = node.arguments;
      if (
        ts.isIdentifier(callee) &&
        arg !== undefined &&
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        const ns = lookup(scopes, callee.text);
        if (ns !== undefined) {
          const key = ns ? `${ns}.${arg.text}` : arg.text;
          if (!known.has(key)) {
            const { line } = source.getLineAndCharacterOfPosition(arg.getStart());
            missing.push({ file: relative(ROOT, path), line: line + 1, key });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
    if (scoped) scopes.pop();
  };
  enter(source);
  ts.forEachChild(source, visit);
  return missing;
}

function main() {
  const args = process.argv.slice(2);
  const ceilingIdx = args.indexOf('--ceiling');
  const ceilingPath = ceilingIdx >= 0 ? resolve(process.cwd(), args[ceilingIdx + 1] ?? '') : undefined;

  const known = flattenKeys(JSON.parse(readFileSync(REFERENCE_CATALOG, 'utf8')));
  const files = globSync('**/*.{ts,tsx}', { cwd: APP_DIR })
    .filter((f) => !/(^|\/)__tests__\/|\.test\.tsx?$/.test(f))
    .map((f) => resolve(APP_DIR, f));
  const missing = files.flatMap((f) => scanFile(f, known));

  for (const m of missing) console.log(`${m.file}:${String(m.line)}  ${m.key}`);
  console.log(`i18n-missing-keys: ${String(missing.length)} key(s) used but absent from messages/en.json`);

  if (!ceilingPath) return;
  const ceiling = JSON.parse(readFileSync(ceilingPath, 'utf8')).missing;
  if (typeof ceiling !== 'number') {
    console.error(`${ceilingPath}: expected a number under "missing"`);
    process.exit(2);
  }
  if (missing.length > ceiling) {
    console.error(
      `i18n-missing-keys: ${String(missing.length)} exceeds the ceiling of ${String(ceiling)}. ` +
        'Add the key to messages/en.json and messages/de.json, or fix the call.',
    );
    process.exit(1);
  }
  if (missing.length < ceiling) {
    console.error(
      `i18n-missing-keys: down to ${String(missing.length)} — lower "missing" in ${relative(ROOT, ceilingPath)} to ${String(missing.length)}.`,
    );
    process.exit(1);
  }
}

main();
