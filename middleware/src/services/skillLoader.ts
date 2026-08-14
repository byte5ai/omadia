import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Reads a SKILL.md (Anthropic-style skill file with YAML frontmatter) and
 * returns the prose body for use as a local sub-agent's system prompt. The
 * frontmatter's `description` is returned separately — we surface it as a
 * delegation hint in the orchestrator's domain-tool description.
 *
 * Skill files live at <skillDir>/SKILL.md. The YAML frontmatter block is
 * stripped from the returned body so the sub-agent doesn't see it.
 */
export interface LoadedSkill {
  /** Filesystem path to SKILL.md, for logging. */
  sourcePath: string;
  /** `description` from the frontmatter, falling back to the skill name. */
  description: string;
  /** Markdown body (frontmatter stripped) — becomes the system prompt. */
  body: string;
}

/** Parsed shape of a raw SKILL.md string, independent of the filesystem. */
export interface ParsedSkillMarkdown {
  /** Frontmatter key/value pairs (empty object if no frontmatter block). */
  frontmatter: Record<string, string>;
  /** Markdown body with the frontmatter block stripped and trimmed. */
  body: string;
  /** `description` from the frontmatter, or undefined if absent. */
  description: string | undefined;
  /**
   * Frontmatter lines carrying data this flat parser cannot represent (list
   * entries, nested mappings). They are dropped from `frontmatter`; reporting
   * them lets the caller tell the user what was lost instead of silently
   * truncating a skill authored for a richer frontmatter dialect.
   */
  unparsedLines: readonly string[];
}

/**
 * Parse a raw SKILL.md string (frontmatter + body) without touching the
 * filesystem, so pasted or uploaded skill text can reuse the same parser as
 * on-disk skills. `loadSkill` layers file IO on top of this.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  // Normalize CRLF so Windows-authored SKILL.md files parse their frontmatter
  // (the delimiter checks below are LF-only) and hash identically to LF files.
  const { frontmatter, body, unparsedLines } = splitFrontmatter(raw.replace(/\r\n/g, '\n'));
  return {
    frontmatter,
    body: body.trim(),
    description: frontmatter['description'],
    unparsedLines,
  };
}

/** Emit a YAML scalar, quoting (as JSON, a YAML subset) when it could misparse. */
function yamlScalar(v: unknown): string {
  if (typeof v === 'string') {
    if (v === '' || /[:#\n]|^[\s>|&*!%@`"'[\]{}]|\s$/.test(v)) return JSON.stringify(v);
    return v;
  }
  return JSON.stringify(v);
}

/**
 * Serialize frontmatter + body back into a SKILL.md string — the inverse of
 * {@link parseSkillMarkdown}, for exporting a registry skill. Keys are sorted
 * for stable output; simple scalars round-trip through parseSkillMarkdown.
 */
export function serializeSkillMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const fm = Object.keys(frontmatter)
    .sort()
    .filter((k) => frontmatter[k] !== undefined)
    .map((k) => `${k}: ${yamlScalar(frontmatter[k])}`)
    .join('\n');
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

export async function loadSkill(skillDir: string): Promise<LoadedSkill> {
  const sourcePath = path.join(skillDir, 'SKILL.md');
  const raw = await fs.readFile(sourcePath, 'utf8');
  const parsed = parseSkillMarkdown(raw);
  const description = parsed.description ?? path.basename(skillDir);
  return { sourcePath, description, body: parsed.body };
}

/** The only frontmatter shape this parser represents: one `key: scalar` line. */
const SCALAR_LINE_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/** Blank lines and YAML comments hold no data, so skipping them loses nothing. */
function isIgnorableFrontmatterLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * True when the next data-bearing line after `index` is one this parser cannot
 * read — i.e. the key at `index` opens a YAML block (list or nested mapping)
 * rather than holding an empty scalar.
 */
function opensUnparsableBlock(lines: readonly string[], index: number): boolean {
  for (let i = index + 1; i < lines.length; i++) {
    const next = lines[i] ?? '';
    if (isIgnorableFrontmatterLine(next)) continue;
    return !SCALAR_LINE_RE.test(next);
  }
  return false;
}

function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
  unparsedLines: readonly string[];
} {
  // Frontmatter is delimited by `---` on its own lines at the top of the file.
  // Anything else and we treat the whole file as body — no fallback parsing
  // heroics; the skill author should fix the file.
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw, unparsedLines: [] };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw, unparsedLines: [] };
  }
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 5);

  // This parser is deliberately flat: one `key: scalar` per line. Richer YAML
  // (lists, nested maps) is not supported — but it must not vanish quietly, so
  // every data-bearing line we cannot represent is collected for the caller.
  const lines = fmRaw.split('\n');
  const frontmatter: Record<string, string> = {};
  const unparsedLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const match = SCALAR_LINE_RE.exec(line);
    if (!match) {
      if (!isIgnorableFrontmatterLine(line)) unparsedLines.push(line);
      continue;
    }
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    // `key:` with nothing after it, followed by lines we cannot read, is a YAML
    // block opener. Storing it as an empty string would invent a value that was
    // never in the source — and that value would travel into the content hash
    // and the risk scan. Report the opener with its block instead, so the
    // reader sees which key the orphaned lines belonged to.
    if (value.trim() === '' && opensUnparsableBlock(lines, i)) {
      unparsedLines.push(line);
      continue;
    }
    frontmatter[key] = unquoteScalar(value.trim());
  }
  return { frontmatter, body, unparsedLines };
}

/**
 * Reverse of {@link yamlScalar}: a double-quoted value is a JSON string (JSON
 * is a YAML subset), so parse it back to its literal — keeping
 * serialize→parse an exact round-trip for values with colons, newlines, etc.
 * Anything not cleanly JSON-parseable is left as the raw trimmed text.
 */
function unquoteScalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not valid JSON — keep the raw value */
    }
  }
  return value;
}
