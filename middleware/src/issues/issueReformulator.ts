/**
 * Reformulates an operator's free-form note into a clean, English GitHub
 * issue (title + body) using the operator's primary connected LLM.
 *
 * There is no provider-level JSON mode in the LLM seam, so we prompt for a
 * single JSON object and parse it defensively (fenced or surrounded by
 * stray text are both tolerated). A parse failure surfaces as a typed
 * error so the route can fall back to the operator's raw text.
 */

import { collectText, textMessage, type LlmProvider } from '@omadia/llm-provider';

export type IssueCategory = 'bug' | 'feature' | 'improvement';

export const ISSUE_CATEGORIES: readonly IssueCategory[] = [
  'bug',
  'feature',
  'improvement',
];

export function isIssueCategory(value: unknown): value is IssueCategory {
  return (
    value === 'bug' || value === 'feature' || value === 'improvement'
  );
}

export interface ReformulatedIssue {
  title: string;
  body: string;
}

export class IssueReformulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueReformulationError';
  }
}

const SYSTEM_PROMPT = `You convert a user's raw note into a clean, well-structured GitHub issue for an open-source software project.

Rules:
- Output ONLY a single JSON object: {"title": string, "body": string}. No prose before or after, no code fences.
- Always write in clear, professional English, regardless of the input language.
- "title": concise, imperative mood, at most 80 characters, no trailing period.
- "body": GitHub-flavored markdown. Never invent facts that are not implied by the note. Keep it faithful to what the user wrote.
- If the category is "bug": use the sections "## Summary", "## Steps to Reproduce", "## Expected Behavior", "## Actual Behavior". Omit a section only if the note genuinely contains nothing for it.
- If the category is "feature" or "improvement": use the sections "## Summary", "## Motivation", "## Proposed Solution".`;

export interface ReformulateInput {
  provider: LlmProvider;
  model: string;
  rawText: string;
  category: IssueCategory;
}

export async function reformulateIssue(
  input: ReformulateInput,
): Promise<ReformulatedIssue> {
  const userMessage = `Category: ${input.category}\n\nUser note:\n${input.rawText}`;
  let text: string;
  try {
    const response = await input.provider.complete({
      model: input.model,
      system: SYSTEM_PROMPT,
      messages: [textMessage('user', userMessage)],
      // Generous budget: reasoning models (e.g. gpt-5.x) spend tokens on
      // hidden reasoning before emitting the JSON. Temperature is omitted
      // on purpose — several reasoning models reject a non-default value.
      maxTokens: 4096,
    });
    text = collectText(response.content);
  } catch (err) {
    throw new IssueReformulationError(
      `llm completion failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  const parsed = parseJsonObject(text);
  const title =
    parsed && typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const body =
    parsed && typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (!title || !body) {
    throw new IssueReformulationError('llm returned malformed issue JSON');
  }
  return { title, body };
}

/** Tolerant JSON-object extractor: strips a ```json fence and/or any text
 *  surrounding the first balanced top-level object. */
function parseJsonObject(
  raw: string,
): { title?: unknown; body?: unknown } | null {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s) as { title?: unknown; body?: unknown };
  } catch {
    return null;
  }
}
