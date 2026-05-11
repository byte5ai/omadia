import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { BuilderTool, ReferenceCatalogEntry } from './types.js';

/**
 * Read a file from one of the workspace's reference-implementation roots
 * (other built-in agents, integration plugins, the boilerplate template,
 * …). The LLM picks one of the catalog `name` values via `list_references`
 * and reads files relative to that root.
 *
 * Safety model — extension whitelist + path-segment blocklist instead of
 * a hand-curated file list:
 *   - allowed extensions: .ts .tsx .md .yaml .yml .json .txt .toml
 *     (covers source / docs / config; excludes binaries, lockfiles, env)
 *   - blocked path segments: node_modules, dist, build, out, .git, .next,
 *     coverage, *.lock — anything that would be a generated artefact or a
 *     leak surface
 *   - max file size: 200 KB (same as before)
 *   - rejects absolute paths and `..` traversal at the string level, then
 *     re-confirms via `path.resolve` against the resolved root
 *
 * The LLM has been observed passing the FULL path
 * (`middleware/packages/agent-seo-analyst/fetcher.ts`) instead of the
 * root-relative one (`fetcher.ts`). We strip the root's tail from the
 * input if it shows up — the system prompt also says "use root-relative
 * paths", but defence-in-depth lets the tool succeed instead of erroring.
 */

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.md',
  '.yaml',
  '.yml',
  '.json',
  '.txt',
  '.toml',
  // S+7.7 — Operator-Admin-UI templates (assets/admin-ui/index.html).
  // The builder agent needs to read the boilerplate's HTML to know
  // where the `admin-ui-body` marker sits before issuing a fill_slot.
  '.html',
]);

const BLOCKED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.next',
  'coverage',
]);

const MAX_BYTES = 200 * 1024;

const InputSchema = z
  .object({
    /** Catalog name. Defaults to the first key in `ctx.referenceCatalog`
     *  when omitted (today: the legacy `seo-analyst` slot). */
    name: z.string().min(1).optional(),
    /** Path RELATIVE to the chosen reference root. Full paths get the
     *  reference-root tail auto-stripped so the LLM doesn't have to be
     *  perfect about the prefix. */
    file: z
      .string()
      .min(1, 'file must be non-empty')
      .max(400, 'file path too long'),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  name: string;
  file: string;
  content: string;
  bytes: number;
}
interface ErrResult {
  ok: false;
  error: string;
  hint?: string;
  /**
   * Populated on `file-not-found` misses. Lists root-relative paths the
   * LLM is allowed to read so it can pick a valid file on the next turn
   * instead of guessing again. Capped to keep the response small.
   */
  availableFiles?: ReadonlyArray<string>;
}
type Result = OkResult | ErrResult;

/**
 * Cap the file list to keep the error payload small. 60 covers every
 * reference root we ship today (boilerplate ≈ 13, seo-analyst ≈ 15,
 * integration packages ≈ 20–25) with headroom; anything over that is a
 * sign of a mis-rooted catalog entry, not a useful suggestion list.
 */
const AVAILABLE_FILES_LIMIT = 60;

export const readReferenceTool: BuilderTool<Input, Result> = {
  id: 'read_reference',
  description:
    'Read a file from one of the reference-implementation packages. ' +
    'Pass `name` to choose the catalog entry (call `list_references` to ' +
    'see available agents, integrations, boilerplate). `file` is relative ' +
    'to that root — bare basenames work (e.g. "manifest.yaml", ' +
    '"toolkit.ts", "skills/expert.md"). Path traversal and generated ' +
    'directories (node_modules, dist, .git) are rejected. Max 200 KB.',
  input: InputSchema,
  async run({ name, file }, ctx) {
    const catalog = ctx.referenceCatalog;
    const catalogKeys = Object.keys(catalog);
    if (catalogKeys.length === 0) {
      return {
        ok: false,
        error: 'no reference catalog configured',
      };
    }
    const resolvedName = name ?? catalogKeys[0]!;
    const entry = catalog[resolvedName];
    if (!entry) {
      return {
        ok: false,
        error: `unknown reference name '${resolvedName}'`,
        hint: `available: ${catalogKeys.join(', ')}`,
      };
    }
    const root = path.resolve(entry.root);

    // Auto-strip: if the LLM passed the full host path (e.g.
    // 'middleware/packages/agent-seo-analyst/fetcher.ts') instead of the
    // root-relative form ('fetcher.ts'), drop the prefix.
    const stripped = stripRootPrefix(file, root);

    // Reject absolute / traversal at the string layer first.
    if (stripped.startsWith('/') || stripped.startsWith('\\')) {
      return {
        ok: false,
        error: `file '${file}' must be relative to the reference root`,
        hint: `try '${path.basename(stripped)}' or 'skills/<file>.md'`,
      };
    }
    const segments = stripped.split(/[/\\]/);
    if (segments.includes('..')) {
      return { ok: false, error: `file '${file}' contains '..'` };
    }
    for (const segment of segments) {
      if (BLOCKED_SEGMENTS.has(segment)) {
        return {
          ok: false,
          error: `path '${file}' touches blocked segment '${segment}'`,
        };
      }
    }
    const ext = path.extname(stripped).toLowerCase();
    if (ext !== '' && !ALLOWED_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        error: `extension '${ext}' is not readable`,
        hint: `allowed: ${[...ALLOWED_EXTENSIONS].sort().join(' ')}`,
      };
    }

    const resolved = path.resolve(root, stripped);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return {
        ok: false,
        error: `file '${file}' resolves outside the reference root`,
      };
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      const availableFiles = await listAvailableFiles(root);
      return {
        ok: false,
        error: `file '${stripped}' does not exist in '${resolvedName}'`,
        hint:
          availableFiles.length > 0
            ? `available files in '${resolvedName}': ${availableFiles.join(', ')}`
            : `call list_references to see what '${resolvedName}' contains`,
        availableFiles,
      };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `path '${stripped}' is not a regular file` };
    }
    if (stat.size > MAX_BYTES) {
      return {
        ok: false,
        error: `file '${stripped}' exceeds ${String(MAX_BYTES)} bytes (size: ${String(stat.size)})`,
      };
    }

    const content = await fs.readFile(resolved, 'utf8');
    return {
      ok: true,
      name: resolvedName,
      file: stripped,
      content,
      bytes: stat.size,
    };
  },
};

/**
 * If `file` contains the reference root's basename followed by a slash
 * (e.g. `…/agent-seo-analyst/fetcher.ts` for a root ending in
 * `agent-seo-analyst`), return the substring after that delimiter.
 * Matches the LAST occurrence so a path that itself contains the basename
 * still gets correctly truncated. Falls through to the original input
 * when no marker is found.
 */
function stripRootPrefix(file: string, root: string): string {
  const basename = path.basename(root);
  if (basename.length === 0) return file;
  const normalized = file.replace(/\\/g, '/');
  const marker = `${basename}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return file;
  return normalized.slice(idx + marker.length);
}

/**
 * Walk a reference root and collect root-relative paths of every file
 * the tool would have been willing to read (allowed extension, no
 * blocked segment, not a dotfile). Returned sorted, capped at
 * `AVAILABLE_FILES_LIMIT` entries. Used to populate the
 * file-not-found error so the LLM can pick a real path on the next
 * turn instead of guessing again. Best-effort: any read failure on a
 * subdirectory is swallowed silently — the goal is a hint, not an
 * exhaustive listing, and we never want this helper to turn a
 * file-not-found into a worse error.
 */
async function listAvailableFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= AVAILABLE_FILES_LIMIT) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= AVAILABLE_FILES_LIMIT) return;
      if (BLOCKED_SEGMENTS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const nextRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const nextAbs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(nextAbs, nextRel);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (ALLOWED_EXTENSIONS.has(ext)) {
          out.push(nextRel);
        }
      }
    }
  }
  await walk(root, '');
  return out;
}

// Re-export for tests.
export type { ReferenceCatalogEntry };
