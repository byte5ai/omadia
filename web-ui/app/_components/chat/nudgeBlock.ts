/**
 * OB-77 — strips the inline `<nudge>` block (`serialiseNudge` in
 * `harness-orchestrator/src/nudgePipeline.ts`) out of a tool_result output so
 * the tool trace shows clean output. The agent still sees the block on its
 * next model call.
 *
 * #1900 — the web chat no longer renders nudge cards (ADR-0021: every
 * decoration needs a concrete, working next action; the card's buttons had
 * none and its text was written for the model). Only the parser stays.
 */

interface ParsedCta {
  readonly label: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

interface ParsedNudge {
  readonly id: string;
  readonly text: string;
  readonly cta?: ParsedCta;
}

interface ParseResult {
  readonly cleaned: string;
  readonly nudge: ParsedNudge | null;
}

const NUDGE_BLOCK_REGEX =
  /<nudge\s+id="([^"]+)">\s*<text>([\s\S]*?)<\/text>(?:\s*<cta\s+label="([^"]+)"\s+tool="([^"]+)">\s*([\s\S]*?)\s*<\/cta>)?\s*<\/nudge>/;

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function parseNudgeBlock(content: string): ParseResult {
  if (!content.includes('<nudge ')) {
    return { cleaned: content, nudge: null };
  }
  const match = NUDGE_BLOCK_REGEX.exec(content);
  if (!match) {
    return { cleaned: content, nudge: null };
  }
  const [block, idAttr, textBody, ctaLabel, ctaTool, ctaArgsJson] = match;
  const id = decodeXml(idAttr ?? '');
  const text = decodeXml((textBody ?? '').trim());

  let cta: ParsedCta | undefined;
  if (ctaLabel !== undefined && ctaTool !== undefined && ctaArgsJson !== undefined) {
    try {
      const args = JSON.parse(ctaArgsJson) as Record<string, unknown>;
      cta = {
        label: decodeXml(ctaLabel),
        toolName: decodeXml(ctaTool),
        args,
      };
    } catch {
      cta = undefined;
    }
  }

  const cleaned = (
    content.slice(0, match.index) +
    content.slice(match.index + (block ?? '').length)
  )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  const parsed: ParsedNudge = cta ? { id, text, cta } : { id, text };
  return { cleaned, nudge: parsed };
}
