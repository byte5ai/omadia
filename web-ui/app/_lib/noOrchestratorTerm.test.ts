import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Spec 2042 criterion 12 (#2057): no user- or operator-facing string says
 * "Orchestrator". `docs/terminology.md` retired the word as a product term:
 * say "agent", or "management layer" when the deterministic layer below the
 * agents is meant. Code identifiers keep the historical name, so the scan only
 * looks at text a person can read:
 *
 *   - every value in `messages/*.json`, in every locale,
 *   - every prose-like string literal, template string and JSX text in the app
 *     sources (test files excluded; comments are code, not UI). A literal is
 *     prose when it contains whitespace or starts with a capital letter.
 *     Lowercase single tokens (translation keys, URL paths, test ids, plugin
 *     ids such as `@omadia/orchestrator`) are code identifiers and stay,
 *   - the markdown files under `messages/`.
 *
 * A hit is a whole word, case-insensitively. `orchestratorToolCalls` or
 * `ORCHESTRATOR_PLUGIN_ID` are identifiers and do not match. What may stay
 * inside readable text is listed in the allowlists below, one entry each, with
 * the reason it stays.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_UI_DIR = path.resolve(HERE, '..', '..');
const APP_DIR = path.join(WEB_UI_DIR, 'app');
const MESSAGES_DIR = path.join(WEB_UI_DIR, 'messages');

const FORBIDDEN = /\borchestrator(s)?\b/i;

/** Message values that may keep the word. Key path is `<locale>:<dotted.key>`. */
const MESSAGE_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // The KG-priorities form is prefilled with the real, persisted id of the
  // default agent (`DEFAULT_AGENT` in the page). The placeholder shows that id
  // verbatim; renaming a persisted id is a backend migration, not a UI string.
  [
    'en:adminKgPriorities.agentIdPlaceholder',
    'verbatim persisted agent id, same value as DEFAULT_AGENT in the page',
  ],
  [
    'de:adminKgPriorities.agentIdPlaceholder',
    'verbatim persisted agent id, same value as DEFAULT_AGENT in the page',
  ],
]);

/** Markdown files that may keep the word. Key is `<file name under messages/>`. */
const MARKDOWN_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'GLOSSARY.md',
    'states that "Orchestrator" is retired and names the replacement; the one place the term is mentioned on purpose',
  ],
]);

type MessageNode = string | { [key: string]: MessageNode };

function flattenMessages(
  node: MessageNode,
  prefix: string,
  out: Map<string, string>,
): void {
  if (typeof node === 'string') {
    out.set(prefix, node);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    flattenMessages(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Prose-like literals: whitespace inside, or a leading capital letter. */
function isProse(text: string): boolean {
  return /\s/.test(text) || /^[A-Z]/.test(text);
}

/** String literals, template strings and JSX text of one source file. */
function readableTexts(file: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      if (isProse(node.text)) texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

describe('#2057 / criterion 12 — no user-facing "Orchestrator"', () => {
  it('no message value in any locale says "Orchestrator"', () => {
    const hits: string[] = [];
    for (const entry of fs.readdirSync(MESSAGES_DIR).sort()) {
      if (!entry.endsWith('.json')) continue;
      const locale = entry.replace(/\.json$/, '');
      const messages = new Map<string, string>();
      flattenMessages(
        JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, entry), 'utf8')) as MessageNode,
        '',
        messages,
      );
      for (const [key, value] of messages) {
        if (FORBIDDEN.test(value) && !MESSAGE_ALLOWLIST.has(`${locale}:${key}`)) {
          hits.push(`${locale}:${key} = ${value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('no string literal or JSX text in the app sources says "Orchestrator"', () => {
    const hits: string[] = [];
    for (const file of listSourceFiles(APP_DIR)) {
      const rel = path.relative(APP_DIR, file).split(path.sep).join('/');
      for (const text of readableTexts(file)) {
        if (FORBIDDEN.test(text)) {
          hits.push(`${rel}: ${text}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('no markdown under messages/ says "Orchestrator"', () => {
    const hits: string[] = [];
    for (const entry of fs.readdirSync(MESSAGES_DIR).sort()) {
      if (!entry.endsWith('.md') || MARKDOWN_ALLOWLIST.has(entry)) continue;
      if (FORBIDDEN.test(fs.readFileSync(path.join(MESSAGES_DIR, entry), 'utf8'))) {
        hits.push(entry);
      }
    }
    expect(hits).toEqual([]);
  });

  it('every allowlist entry is still needed', () => {
    // A stale entry is a hole: it would excuse a future string that happens to
    // match. Drop entries when the text they excuse is gone.
    const messageKeys = new Set<string>();
    for (const entry of fs.readdirSync(MESSAGES_DIR)) {
      if (!entry.endsWith('.json')) continue;
      const locale = entry.replace(/\.json$/, '');
      const flat = new Map<string, string>();
      flattenMessages(
        JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, entry), 'utf8')) as MessageNode,
        '',
        flat,
      );
      for (const [key, value] of flat) {
        if (FORBIDDEN.test(value)) messageKeys.add(`${locale}:${key}`);
      }
    }
    for (const key of MESSAGE_ALLOWLIST.keys()) {
      expect(messageKeys.has(key), `stale message allowlist entry ${key}`).toBe(true);
    }
  });
});
