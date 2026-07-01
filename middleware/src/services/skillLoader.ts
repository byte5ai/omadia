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
}

/**
 * Parse a raw SKILL.md string (frontmatter + body) without touching the
 * filesystem, so pasted or uploaded skill text can reuse the same parser as
 * on-disk skills. `loadSkill` layers file IO on top of this.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const { frontmatter, body } = splitFrontmatter(raw);
  return { frontmatter, body: body.trim(), description: frontmatter['description'] };
}

export async function loadSkill(skillDir: string): Promise<LoadedSkill> {
  const sourcePath = path.join(skillDir, 'SKILL.md');
  const raw = await fs.readFile(sourcePath, 'utf8');
  const parsed = parseSkillMarkdown(raw);
  const description = parsed.description ?? path.basename(skillDir);
  return { sourcePath, description, body: parsed.body };
}

function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Frontmatter is delimited by `---` on its own lines at the top of the file.
  // Anything else and we treat the whole file as body — no fallback parsing
  // heroics; the skill author should fix the file.
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 5);

  const frontmatter: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      frontmatter[key] = value.trim();
    }
  }
  return { frontmatter, body };
}
