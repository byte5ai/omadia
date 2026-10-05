/**
 * Mines the built-in tool inventory out of an installed `claude` CLI binary,
 * for the deny-list drift guard in `test/cliBridge/cliSpawnGate.test.ts`.
 *
 * The CLI ships as a Bun single-file executable whose JavaScript source is
 * embedded as text, so the inventory can be read without running the binary
 * and without credentials. Two layouts have been observed:
 *
 *   - `literal-inventory` (2.1.259 and nearby): one minified array literal of
 *     quoted names — 183 entries, 105 `mcp__…` and 78 built-ins.
 *   - `tool-definitions` (2.1.286 to at least 2.1.289): no such array. The
 *     source is split into ~2,200 ES-module chunks, every tool name is a
 *     string constant (`var dn="Write";export{dn}`), and each tool is an
 *     object literal `{name:dn,…,searchHint:…,maxResultSizeChars:…}` in some
 *     other chunk that imports the constant. Resolving a name therefore means
 *     following `import{…}from"/$bunfs/root/chunk-….js"` to the chunk that
 *     exports and declares it.
 *
 * A tool definition is an object literal with a top-level `name:` key that
 * also carries at least one key only tool definitions have (see
 * {@link TOOL_DEFINITION_KEYS}). Its `aliases:[…]` array, when present, is
 * read from the same object, which is what keeps highlight.js language
 * metadata (`{name:"Cedar",aliases:["cedarpolicy"]}`) out of the result.
 *
 * Nothing here decides whether drift is acceptable. The caller subtracts the
 * deny list and asserts that the miner actually understood the binary.
 */

/** Keys that occur in the CLI's tool definitions and nowhere else nearby. */
export const TOOL_DEFINITION_KEYS: readonly string[] = [
  'searchHint',
  'maxResultSizeChars',
  'enablesCodeExecution',
  'isConcurrencySafe',
];

/** The generic template every MCP tool is cloned from; renamed at runtime. */
const MCP_TEMPLATE_NAME = 'mcp';

/** How far a single object literal may run before the scan gives up. */
const MAX_OBJECT_SCAN = 200_000;

/** The layout of the old inventory array: 50+ quoted identifiers. */
const LITERAL_INVENTORY = /\[((?:"[A-Za-z_][A-Za-z0-9_.-]*",){49,}"[A-Za-z_][A-Za-z0-9_.-]*")\]/g;
const LITERAL_INVENTORY_ANCHORS: readonly string[] = ['Bash', 'Read', 'WebFetch', 'Grep'];

export type CliInventoryFormat = 'literal-inventory' | 'tool-definitions';

/** A tool definition whose `name:` the miner could not follow to a string. */
export interface UnresolvedToolName {
  readonly identifier: string;
  readonly reason: 'import-not-found' | 'ambiguous' | 'no-string-declaration';
  readonly candidates: readonly string[];
}

export interface CliToolInventory {
  /** Every layout that contributed at least one name. */
  readonly formats: readonly CliInventoryFormat[];
  /** Built-in tool names, `mcp__…` excluded, sorted. */
  readonly builtins: readonly string[];
  /** Aliases attached to tool definitions, sorted. */
  readonly aliases: readonly string[];
  /** The CLI's own SDK list `BUILTIN_TOOL_NAMES`, when the binary carries one. */
  readonly sdkBuiltinNames: readonly string[];
  /**
   * Tool definitions whose name the miner could not follow to one string:
   * an import no chunk resolves, exporters that disagree, or a local without
   * a string value. These are blind spots: a tool exists whose name is unknown.
   */
  readonly unresolved: readonly UnresolvedToolName[];
  /**
   * Tool definitions whose `name:` is a parameter of the enclosing function,
   * i.e. a factory (`function m(e){return{name:e.name,searchHint:…}}`). Such a
   * factory is only reached through call sites like
   * `m({name:Um,searchHint:…})`, and those carry the tool-definition keys
   * themselves, so they are mined as definitions of their own.
   */
  readonly parameterNames: number;
}

type Resolution =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'parameter' }
  | Omit<UnresolvedToolName, 'identifier'> & { readonly kind: 'unresolved' };

interface Chunk {
  readonly start: number;
  readonly text: string;
  /** Local binding → {exported name, module path}. */
  readonly imports: ReadonlyMap<string, { readonly exported: string; readonly from: string }>;
}

const IDENT = '[A-Za-z_$][\\w$]*';

function escapeIdent(ident: string): string {
  return ident.replace(/\$/g, '\\$');
}

/** Index of the character after a quoted string or template opening at `i`. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) {
    if (text[j] === '\\') j += 1;
    j += 1;
  }
  return j + 1;
}

/**
 * The top-level keys of the object literal that contains position `from`,
 * scanning forward to its closing brace, plus the raw text of its `aliases`.
 * `from` must sit at depth 0 of that object (directly after a `{` or `,`).
 */
function trailingKeys(text: string, from: number): { keys: Set<string>; aliasesRaw?: string } {
  const keys = new Set<string>();
  let aliasesRaw: string | undefined;
  let depth = 0;
  let i = from;
  const limit = Math.min(text.length, from + MAX_OBJECT_SCAN);
  let atKeyStart = true;
  while (i < limit) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(text, i);
      atKeyStart = false;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && ch === ',') {
      atKeyStart = true;
      i += 1;
      continue;
    } else if (depth === 0 && atKeyStart) {
      const key = /^(?:async |get |set )?([A-Za-z_$][\w$]*)\s*[:(]/.exec(text.slice(i, i + 80));
      if (key?.[1]) {
        keys.add(key[1]);
        if (key[1] === 'aliases' && text.startsWith('aliases:[', i)) {
          const end = text.indexOf(']', i);
          aliasesRaw = text.slice(i + 'aliases:['.length, end);
        }
      }
      atKeyStart = false;
    }
    i += 1;
  }
  return { keys, aliasesRaw };
}

/** How far back from a `name:` key the enclosing function's head may sit. */
const PARAMETER_WINDOW = 600;

/**
 * Is `ident` a parameter of a function whose head opens shortly before `at`?
 * Matches `function f(a,ident)`, `(a,ident)=>`, `ident=>` and a destructured
 * `({ident})=>`. A factory body is short, so the window stays small.
 */
function isParameterAt(text: string, at: number, ident: string): boolean {
  const before = text.slice(Math.max(0, at - PARAMETER_WINDOW), at);
  const id = escapeIdent(ident);
  const inList = `[^()]*?(?<![\\w$])${id}(?![\\w$])[^()]*?`;
  return new RegExp(
    `function\\s*[\\w$]*\\(${inList}\\)|\\(${inList}\\)=>|(?<![\\w$.])${id}=>`,
  ).test(before);
}

function splitChunks(text: string): Chunk[] {
  const starts = [...text.matchAll(/\/\/ @bun\b/g)].map((m) => m.index);
  if (starts.length === 0) starts.push(0);
  return starts.map((start, index) => {
    const chunkText = text.slice(start, starts[index + 1] ?? text.length);
    const imports = new Map<string, { exported: string; from: string }>();
    for (const m of chunkText.matchAll(/import\{([^}]*)\}from"([^"]+)"/g)) {
      for (const spec of (m[1] ?? '').split(',')) {
        const [exported, local] = spec.split(' as ').map((part) => part.trim());
        if (exported) imports.set(local ?? exported, { exported, from: m[2] ?? '' });
      }
    }
    return { start, text: chunkText, imports };
  });
}

export function mineCliToolInventory(binaryText: string): CliToolInventory {
  const formats = new Set<CliInventoryFormat>();
  const builtins = new Set<string>();
  const aliases = new Set<string>();
  const unresolved = new Map<string, UnresolvedToolName>();
  let parameterNames = 0;

  // Layout 1: the literal inventory array.
  for (const match of binaryText.matchAll(LITERAL_INVENTORY)) {
    const names = [...(match[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    if (!LITERAL_INVENTORY_ANCHORS.every((anchor) => names.includes(anchor))) continue;
    formats.add('literal-inventory');
    for (const name of names) if (!name.startsWith('mcp__')) builtins.add(name);
  }

  // Layout 2: tool definition objects, names resolved through module imports.
  const chunks = splitChunks(binaryText);
  const exportIndex = new Map<string, { chunk: number; local: string }[]>();
  chunks.forEach((chunk, index) => {
    for (const m of chunk.text.matchAll(/export\{([^}]*)\}/g)) {
      for (const spec of (m[1] ?? '').split(',')) {
        const [local, exported] = spec.split(' as ').map((part) => part.trim());
        if (!local) continue;
        const key = exported ?? local;
        const list = exportIndex.get(key) ?? [];
        list.push({ chunk: index, local });
        exportIndex.set(key, list);
      }
    }
  });
  const chunkAt = (position: number): number => {
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((chunks[mid] as Chunk).start <= position) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const resolve = (chunkIndex: number, ident: string, depth = 0, at?: number): Resolution => {
    const chunk = chunks[chunkIndex] as Chunk;
    const declaration = new RegExp(`(?:\\bvar |\\blet |\\bconst |,)${escapeIdent(ident)}="([^"\\\\]*)"[,;\\n]`, 'g');
    const local = new Set([...chunk.text.matchAll(declaration)].map((m) => m[1] as string));
    if (local.size === 1) return { kind: 'value', value: [...local][0] as string };
    if (local.size > 1) return { kind: 'unresolved', reason: 'ambiguous', candidates: [...local].sort() };
    const imported = chunk.imports.get(ident);
    if (!imported) {
      // Only a binding the enclosing function declares as its parameter is a
      // factory input. Any other local without a string value (`var X=fn()`,
      // a declaration form this regex does not know) is a blind spot.
      return at !== undefined && isParameterAt(binaryText, at, ident)
        ? { kind: 'parameter' }
        : { kind: 'unresolved', reason: 'no-string-declaration', candidates: [] };
    }
    if (depth > 8) return { kind: 'unresolved', reason: 'import-not-found', candidates: [] };
    // The minified export name can repeat across chunks, and the import path
    // is not mapped to a chunk here, so every exporter must agree. One that
    // does not resolve to a string makes the name unresolved rather than
    // letting another chunk's value stand in for it.
    const values = new Set<string>();
    let anyUnresolved = false;
    for (const exporter of exportIndex.get(imported.exported) ?? []) {
      const result = resolve(exporter.chunk, exporter.local, depth + 1);
      if (result.kind === 'value') values.add(result.value);
      else anyUnresolved = true;
    }
    if (values.size === 1 && !anyUnresolved) return { kind: 'value', value: [...values][0] as string };
    return {
      kind: 'unresolved',
      reason: values.size > 1 ? 'ambiguous' : 'import-not-found',
      candidates: [...values].sort(),
    };
  };

  const nameKey = new RegExp(`[{,]name:(${IDENT}|"[^"\\\\]*")(?=[,}])`, 'g');
  for (const match of binaryText.matchAll(nameKey)) {
    const { keys, aliasesRaw } = trailingKeys(binaryText, match.index + 1);
    if (!TOOL_DEFINITION_KEYS.some((key) => keys.has(key))) continue;
    const chunkIndex = chunkAt(match.index);
    const valueOf = (raw: string): string | undefined => {
      if (raw.startsWith('"')) return raw.slice(1, -1);
      const result = resolve(chunkIndex, raw, 0, match.index);
      if (result.kind === 'value') return result.value;
      if (result.kind === 'parameter') {
        parameterNames += 1;
        return undefined;
      }
      unresolved.set(raw, { identifier: raw, reason: result.reason, candidates: result.candidates });
      return undefined;
    };

    const name = valueOf(match[1] as string);
    if (name === undefined || name === MCP_TEMPLATE_NAME || name.startsWith('mcp__')) continue;
    formats.add('tool-definitions');
    builtins.add(name);
    for (const part of (aliasesRaw ?? '').split(',')) {
      const raw = part.trim();
      if (!raw || raw === 'void 0') continue;
      const alias = valueOf(raw);
      if (alias !== undefined) aliases.add(alias);
    }
  }

  // The SDK's own list, independent of either layout above.
  const sdkList = /BUILTIN_TOOL_NAMES=\[((?:"[^"]*",?)+)\]/.exec(binaryText);
  const sdkBuiltinNames = sdkList
    ? [...(sdkList[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
    : [];

  return {
    formats: [...formats],
    builtins: [...builtins].sort(),
    aliases: [...aliases].sort(),
    sdkBuiltinNames,
    unresolved: [...unresolved.values()],
    parameterNames,
  };
}
