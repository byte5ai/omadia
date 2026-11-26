import yaml from 'yaml';

/**
 * #1736 — `{{TOKEN}}` substitution that respects the target file's format.
 *
 * Spec text (a description with `"` or `\`, a name with an apostrophe) used to
 * be spliced into the template verbatim, so `package.json` and `manifest.yaml`
 * stopped parsing and the build failed with `reason=unknown`. Each format now
 * gets its value in a form it can hold:
 *
 *   - `.json`  → parsed, placeholders replaced inside string values, re-serialised
 *                (`JSON.stringify` does the escaping);
 *   - `.yaml`  → parsed into the YAML AST, placeholders replaced inside scalars
 *                and comments, re-serialised (the scalar keeps its quoting style,
 *                the library escapes for it);
 *   - `.ts`/`.js` → value escaped so it is valid inside a `'…'`, `"…"` or
 *                template literal and harmless inside a comment;
 *   - `.html`  → HTML-escaped;
 *   - anything else → verbatim.
 *
 * Replacement is a single pass: a value that itself contains `{{X}}` is not
 * substituted again (see `findReservedBraces`, which rejects such values with
 * the spec field named).
 */

const TOKEN_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const HAS_TOKEN_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/;

type Escaper = (value: string) => string;

function replaceTokens(text: string, map: ReadonlyMap<string, string>, escape: Escaper): string {
  return text.replace(TOKEN_RE, (whole, token: string) => {
    const value = map.get(token);
    return value === undefined ? whole : escape(value);
  });
}

const identity: Escaper = (value) => value;

/** Valid inside single-, double- and backtick-quoted JS strings, and inert in
 *  `//` and block comments (no raw newline, no `*\/`). */
export const escapeForJs: Escaper = (value) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\*\//g, '*\\/')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export const escapeForHtml: Escaper = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A YAML comment ends at the line break, so a value there stays on one line. */
const singleLine: Escaper = (value) => value.replace(/[\r\n]+/g, ' ');

function substituteJsonValue(node: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof node === 'string') return replaceTokens(node, map, identity);
  if (Array.isArray(node)) return node.map((item) => substituteJsonValue(item, map));
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, substituteJsonValue(v, map)]),
    );
  }
  return node;
}

function substituteInJson(text: string, map: ReadonlyMap<string, string>): string {
  if (!HAS_TOKEN_RE.test(text)) return text;
  const parsed: unknown = JSON.parse(text);
  return JSON.stringify(substituteJsonValue(parsed, map), null, 2) + '\n';
}

interface Commented {
  comment?: string | null;
  commentBefore?: string | null;
}

function substituteComments(node: Commented, map: ReadonlyMap<string, string>): void {
  if (typeof node.comment === 'string') node.comment = replaceTokens(node.comment, map, singleLine);
  if (typeof node.commentBefore === 'string') {
    node.commentBefore = replaceTokens(node.commentBefore, map, singleLine);
  }
}

function substituteInYaml(text: string, map: ReadonlyMap<string, string>): string {
  if (!HAS_TOKEN_RE.test(text)) return text;
  const doc = yaml.parseDocument(text);
  substituteComments(doc, map);
  yaml.visit(doc, (_key, node) => {
    if (node === null || typeof node !== 'object') return;
    substituteComments(node as Commented, map);
    if (yaml.isScalar(node) && typeof node.value === 'string') {
      node.value = replaceTokens(node.value, map, identity);
    }
  });
  return doc.toString();
}

function extensionOf(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  return dot === -1 ? '' : relPath.slice(dot).toLowerCase();
}

/** Replace every `{{TOKEN}}` in `text` with its value, encoded for the format
 *  `relPath` names. Unknown tokens stay, so the residue check still sees them. */
export function substitutePlaceholdersFor(
  relPath: string,
  text: string,
  map: ReadonlyMap<string, string>,
): string {
  switch (extensionOf(relPath)) {
    case '.json':
      return substituteInJson(text, map);
    case '.yaml':
    case '.yml':
      return substituteInYaml(text, map);
    case '.ts':
    case '.js':
    case '.mjs':
    case '.cjs':
      return replaceTokens(text, map, escapeForJs);
    case '.html':
      return replaceTokens(text, map, escapeForHtml);
    default:
      return replaceTokens(text, map, identity);
  }
}

/** Verbatim substitution, for file paths. */
export function substitutePlaceholdersPlain(text: string, map: ReadonlyMap<string, string>): string {
  return replaceTokens(text, map, identity);
}

/** Tokens whose value contains `{{X}}` braces themselves. Such a value would
 *  survive substitution as a literal placeholder and trip the residue check
 *  with a message that blames the template, not the spec field. */
export function findReservedBraces(map: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [token, value] of map) {
    if (HAS_TOKEN_RE.test(value)) out.push(token);
  }
  return out;
}
