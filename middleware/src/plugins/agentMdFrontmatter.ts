import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  PersonaConfigSchema,
  QualityConfigSchema,
  type PersonaConfig,
  type QualityConfig,
} from './builder/agentSpec.js';

/**
 * Phase 3 / OB-67 Slice 7 — pure reader for `agent.md` frontmatter.
 *
 * Phase 1 (Quality-Guard) and Phase 3 (Persona) both write structured
 * config blocks into the AGENT.md frontmatter. Until this reader landed
 * those blocks were doc-only — `responseGuard@1` consumed quality
 * settings from plugin-default config (NOT per-profile frontmatter), and
 * persona had no runtime path at all.
 *
 * This reader closes the loop:
 *   1. Strip the leading `---\n…\n---\n` block (lossless, never rewrites
 *      the body).
 *   2. Parse the YAML, validate `quality:` and `persona:` against the
 *      canonical Zod schemas in `agentSpec.ts`.
 *   3. Return both blocks as typed objects, or `null` for blocks that
 *      are missing / fail validation. Validation failures are logged
 *      but never throw — the runtime keeps running, just without the
 *      frontmatter-driven override.
 *
 * Pure function: no I/O, no caching. Callers cache the result however
 * they want.
 */

const FRONTMATTER_SCHEMA = z
  .object({
    quality: QualityConfigSchema.optional(),
    persona: PersonaConfigSchema.optional(),
  })
  .passthrough(); // unknown frontmatter keys (identity, schema_version, …) survive

export interface AgentMdFrontmatter {
  /** Parsed quality block, or `undefined` when absent / invalid. */
  quality?: QualityConfig;
  /** Parsed persona block, or `undefined` when absent / invalid. */
  persona?: PersonaConfig;
  /** Raw frontmatter object — useful for callers that need other keys
   *  (identity.id, schema_version, …). Empty object when there was no
   *  frontmatter at all. */
  raw: Record<string, unknown>;
}

export interface AgentMdParseResult {
  frontmatter: AgentMdFrontmatter | null;
  body: string;
}

const FRONTMATTER_OPENER = /^---\r?\n/;
// Closing `---` may appear at start-of-afterOpener (empty frontmatter) or
// at the start of any subsequent line. The /m flag anchors `^` to line
// starts; the optional newline makes the regex tolerant of an EOF-closer.
const FRONTMATTER_CLOSER = /^---\r?\n?/m;

/**
 * Parse `agent.md` (or any markdown with optional YAML frontmatter).
 * The body is returned with the conventional blank line after the
 * closing `---` stripped (one newline only). `frontmatter` is `null`
 * when:
 *   - no leading `---` line
 *   - no closing `---` line
 *   - YAML parse error (logged via `log` if provided) — the original
 *     text is returned as body so caller content is never silently
 *     corrupted
 *   - parsed frontmatter is not an object
 */
export function parseAgentMd(
  content: string | Buffer,
  log?: (msg: string) => void,
): AgentMdParseResult {
  const text =
    typeof content === 'string' ? content : content.toString('utf8');

  const openerMatch = FRONTMATTER_OPENER.exec(text);
  if (!openerMatch) {
    return { frontmatter: null, body: text };
  }

  const afterOpener = text.slice(openerMatch[0].length);
  const closeMatch = FRONTMATTER_CLOSER.exec(afterOpener);
  if (!closeMatch) {
    return { frontmatter: null, body: text };
  }

  const yamlText = afterOpener.slice(0, closeMatch.index);
  let body = afterOpener.slice(closeMatch.index + closeMatch[0].length);
  // Strip the conventional single blank line between the closer and the
  // markdown body so callers don't have to special-case the leading \n.
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    log?.(
      `[agentMdFrontmatter] YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { frontmatter: null, body: text };
  }

  if (parsed === null || parsed === undefined) {
    // Empty frontmatter is valid — treat as no overrides, no error.
    return { frontmatter: { raw: {} }, body };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    log?.(
      '[agentMdFrontmatter] frontmatter must be a YAML mapping at the root',
    );
    return { frontmatter: null, body };
  }

  const raw = parsed as Record<string, unknown>;

  // Validate quality + persona independently so a malformed quality
  // block doesn't suppress a valid persona block (and vice versa).
  let quality: QualityConfig | undefined;
  let persona: PersonaConfig | undefined;

  if (raw['quality'] !== undefined) {
    const q = QualityConfigSchema.safeParse(raw['quality']);
    if (q.success) {
      quality = q.data;
    } else {
      log?.(
        `[agentMdFrontmatter] quality block invalid: ${q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
  }
  if (raw['persona'] !== undefined) {
    const p = PersonaConfigSchema.safeParse(raw['persona']);
    if (p.success) {
      persona = p.data;
    } else {
      log?.(
        `[agentMdFrontmatter] persona block invalid: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
  }

  // Top-level shape check (non-blocking, just for the log).
  const shape = FRONTMATTER_SCHEMA.safeParse(raw);
  if (!shape.success) {
    log?.(
      `[agentMdFrontmatter] frontmatter has unexpected shape: ${shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  const out: AgentMdFrontmatter = { raw };
  if (quality !== undefined) out.quality = quality;
  if (persona !== undefined) out.persona = persona;
  return { frontmatter: out, body };
}
